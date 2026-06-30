import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { callLlm, type LlmCallConfig } from '../driver/call-llm';
import type { LlmEndpoint } from '../llm/types';
import type {
  ConversationEntry,
  ImagePart,
  InputMessage,
  OutputMessage,
} from '../unified-api/types';

export const createSemaphore = (max: number) => {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (current < max) { current++; resolve(); } else queue.push(resolve);
    }),
    release: () => {
      current--;
      const next = queue.shift();
      if (next) { current++; next(); }
    },
  };
};

const toImagePart = (buffer: Buffer): ImagePart => ({
  kind: 'image',
  image: sharp(buffer),
  detail: undefined,
});

const extractDescriptionText = (entries: ConversationEntry[]): string => {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'message' || e.role !== 'assistant') continue;
    for (const p of (e as OutputMessage).parts) {
      if (p.kind === 'text') parts.push(p.text);
      else if (p.kind === 'textGroup') for (const t of p.content) parts.push(t.text);
    }
  }
  return parts.join('').trim();
};

/** Shared LLM call for image/animation description workflows. */
export const callDescriptionLlm = async (params: {
  model: LlmEndpoint;
  system: string;
  userText: string;
  images: Buffer[];
  log: Logger;
  label: string;
}): Promise<{ text: string; outputTokens: number }> => {
  const { model, system, userText, images, log, label } = params;

  log.withFields({ systemLen: system.length, images: images.length, apiFormat: model.apiFormat ?? 'openai-chat' }).log(`${label} request`);

  const entries: ConversationEntry[] = [{
    kind: 'message',
    role: 'user',
    parts: [
      { kind: 'text', text: userText },
      ...images.map(toImagePart),
    ],
  } satisfies InputMessage];

  const config: LlmCallConfig = {
    apiBaseUrl: model.apiBaseUrl,
    apiKey: model.apiKey,
    model: model.model,
    ...(model.apiFormat ? { apiFormat: model.apiFormat } : {}),
    ...(model.timeoutSec ? { timeoutSec: model.timeoutSec } : {}),
    ...(model.extraBody ? { extraBody: model.extraBody } : {}),
    ...(model.forceToolCall ? { forceToolCall: model.forceToolCall } : {}),
  };

  const result = await callLlm(
    config,
    entries,
    system,
    undefined,
    { log, label, ...(model.maxImagesAllowed ? { maxImagesAllowed: model.maxImagesAllowed } : {}) },
  );

  return {
    text: extractDescriptionText(result.entries),
    outputTokens: result.usage.outputTokens,
  };
};
