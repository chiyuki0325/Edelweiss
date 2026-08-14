import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { callLlm } from '../driver/call-llm';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry, InputMessage, OutputMessage } from '../unified-api/types';

const INITIAL_IMAGE_TOKENS = 100;
const CHARS_PER_TOKEN = 2;

export interface ImageConversationRecord {
  id: number;
  chatId: string;
  imageId: string;
  sourceFingerprint: string;
  imageHash: string;
  preparedImageBase64: string;
  systemPrompt: string;
  initialUserText: string;
  initialResponse: string;
  initialOutputTokens: number;
  modelName: string;
  currentGeneration: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ImageConversationTurn {
  generation: number;
  sequence: number;
  question: string;
  answer: string;
  inputTokens: number;
  outputTokens: number;
  modelName: string;
  createdAtMs: number;
}

export interface ImageConversationStore {
  load(chatId: string, imageId: string): ImageConversationRecord | null;
  create(record: Omit<ImageConversationRecord, 'id'>): ImageConversationRecord;
  loadTurns(conversationId: number, generation: number): ImageConversationTurn[];
  appendTurn(params: {
    conversationId: number;
    expectedGeneration: number;
    reset: boolean;
    turn: Omit<ImageConversationTurn, 'generation' | 'sequence'>;
  }): { generation: number; sequence: number };
}

export interface StartImageConversationParams {
  chatId: string;
  sourceKey: string;
  imageHash: string;
  preparedImage: Buffer;
  systemPrompt: string;
  initialUserText: string;
  model: LlmEndpoint;
  label: string;
  initialResponse?: string;
  initialOutputTokens?: number;
}

export interface AskImageResult {
  answer: string;
  historyReset: boolean;
}

const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

export const createImageConversationId = (params: {
  chatId: string;
  sourceKey: string;
  imageHash: string;
  systemPrompt: string;
  initialUserText: string;
}): string => `img_${hash(JSON.stringify(params))}`;

export const createImageSourceFingerprint = (sourceKey: string): string =>
  hash(sourceKey);

const extractAssistantText = (entries: ConversationEntry[]): string => {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of (entry as OutputMessage).parts) {
      if (part.kind === 'text') parts.push(part.text);
      else if (part.kind === 'textGroup') parts.push(...part.content.map(text => text.text));
    }
  }
  return parts.join('').trim();
};

export interface ImageConversationModelCallParams {
  model: LlmEndpoint;
  systemPrompt: string;
  entries: ConversationEntry[];
  log: Logger;
  label: string;
}

export interface ImageConversationModelCallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

const callModel = async (params: ImageConversationModelCallParams): Promise<ImageConversationModelCallResult> => {
  const result = await callLlm({
    apiBaseUrl: params.model.apiBaseUrl,
    apiKey: params.model.apiKey,
    model: params.model.model,
    ...(params.model.apiFormat ? { apiFormat: params.model.apiFormat } : {}),
    ...(params.model.timeoutSec ? { timeoutSec: params.model.timeoutSec } : {}),
    ...(params.model.extraBody ? { extraBody: params.model.extraBody } : {}),
    ...(params.model.forceToolCall ? { forceToolCall: params.model.forceToolCall } : {}),
  }, params.entries, params.systemPrompt, undefined, {
    log: params.log,
    label: params.label,
    ...(params.model.maxImagesAllowed ? { maxImagesAllowed: params.model.maxImagesAllowed } : {}),
  });
  const text = extractAssistantText(result.entries);
  if (!text) throw new Error('Image model returned empty content');
  return { text, usage: result.usage };
};

const baseEntries = (conversation: ImageConversationRecord): ConversationEntry[] => [{
  kind: 'message',
  role: 'user',
  parts: [
    { kind: 'text', text: conversation.initialUserText },
    { kind: 'image', image: sharp(Buffer.from(conversation.preparedImageBase64, 'base64')), detail: undefined },
  ],
} satisfies InputMessage, {
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text: conversation.initialResponse }],
  reasoning: undefined,
} satisfies OutputMessage];

const turnEntries = (turns: ImageConversationTurn[]): ConversationEntry[] => turns.flatMap(turn => [{
  kind: 'message' as const,
  role: 'user' as const,
  parts: [{ kind: 'text' as const, text: turn.question }],
}, {
  kind: 'message' as const,
  role: 'assistant' as const,
  parts: [{ kind: 'text' as const, text: turn.answer }],
  reasoning: undefined,
}]);

const estimateContextTokens = (
  conversation: ImageConversationRecord,
  turns: ImageConversationTurn[],
  question: string,
): number => INITIAL_IMAGE_TOKENS + Math.ceil((
  conversation.systemPrompt.length
  + conversation.initialUserText.length
  + conversation.initialResponse.length
  + question.length
  + turns.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0)
) / CHARS_PER_TOKEN);

const isContextLengthError = (error: unknown): boolean => {
  const message = String(error instanceof Error ? error.message : error);
  return /context.{0,30}(length|window)|maximum context|too many tokens|request too large/i.test(message);
};

export const createImageConversationManager = (deps: {
  store: ImageConversationStore;
  logger: Logger;
  callModel?: (params: ImageConversationModelCallParams) => Promise<ImageConversationModelCallResult>;
}) => {
  const log = deps.logger.withContext('image-conversation');
  const invokeModel = deps.callModel ?? callModel;
  const locks = new Map<string, Promise<void>>();

  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    locks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  };

  const start = async (params: StartImageConversationParams) => {
    const imageId = createImageConversationId({
      chatId: params.chatId,
      sourceKey: params.sourceKey,
      imageHash: params.imageHash,
      systemPrompt: params.systemPrompt,
      initialUserText: params.initialUserText,
    });
    return await withLock(`${params.chatId}:${imageId}`, async () => {
      const existing = deps.store.load(params.chatId, imageId);
      if (existing) {
        return { imageId, description: existing.initialResponse, reused: true };
      }

      const initial = params.initialResponse != null
        ? { text: params.initialResponse.trim(), outputTokens: params.initialOutputTokens ?? 0 }
        : await invokeModel({
          model: params.model,
          systemPrompt: params.systemPrompt,
          entries: [{
            kind: 'message',
            role: 'user',
            parts: [
              { kind: 'text', text: params.initialUserText },
              { kind: 'image', image: sharp(params.preparedImage), detail: undefined },
            ],
          } satisfies InputMessage],
          log,
          label: params.label,
        }).then(result => ({ text: result.text, outputTokens: result.usage.outputTokens }));
      if (!initial.text) throw new Error('Image model returned empty content');

      const now = Date.now();
      deps.store.create({
        chatId: params.chatId,
        imageId,
        sourceFingerprint: createImageSourceFingerprint(params.sourceKey),
        imageHash: params.imageHash,
        preparedImageBase64: params.preparedImage.toString('base64'),
        systemPrompt: params.systemPrompt,
        initialUserText: params.initialUserText,
        initialResponse: initial.text,
        initialOutputTokens: initial.outputTokens,
        modelName: params.model.model,
        currentGeneration: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });
      return { imageId, description: initial.text, reused: false };
    });
  };

  const ask = async (params: {
    chatId: string;
    imageId: string;
    question: string;
    model: LlmEndpoint;
    maxContextEstTokens: number;
  }): Promise<AskImageResult> => await withLock(`${params.chatId}:${params.imageId}`, async () => {
    const conversation = deps.store.load(params.chatId, params.imageId);
    if (!conversation) throw new Error('Unknown image_id for this chat');
    const turns = deps.store.loadTurns(conversation.id, conversation.currentGeneration);
    let reset = estimateContextTokens(conversation, turns, params.question) > params.maxContextEstTokens;

    const makeEntries = (includeTurns: boolean): ConversationEntry[] => [
      ...baseEntries(conversation),
      ...(includeTurns ? turnEntries(turns) : []),
      { kind: 'message', role: 'user', parts: [{ kind: 'text', text: params.question }] } satisfies InputMessage,
    ];

    let result;
    try {
      result = await invokeModel({
        model: params.model,
        systemPrompt: conversation.systemPrompt,
        entries: makeEntries(!reset),
        log,
        label: `ask-for-image:${params.imageId}`,
      });
    } catch (error) {
      if (reset || !isContextLengthError(error)) throw error;
      reset = true;
      result = await invokeModel({
        model: params.model,
        systemPrompt: conversation.systemPrompt,
        entries: makeEntries(false),
        log,
        label: `ask-for-image:${params.imageId}:reset`,
      });
    }

    deps.store.appendTurn({
      conversationId: conversation.id,
      expectedGeneration: conversation.currentGeneration,
      reset,
      turn: {
        question: params.question,
        answer: result.text,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        modelName: params.model.model,
        createdAtMs: Date.now(),
      },
    });
    return { answer: result.text, historyReset: reset };
  });

  return { start, ask };
};

export type ImageConversationManager = ReturnType<typeof createImageConversationManager>;
