import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message } from 'xsai';

import { DUMP_DIR, ensureDumpDir } from './constants';
import { composeContext } from './context';
import { messagesToResponsesInput } from './convert';
import { renderCompactionSystemPrompt, renderCompactionUserInstruction } from './prompt';
import type { ResponseOutputMessage } from './responses-types';
import { streamingChat } from './streaming';
import { streamingResponses } from './streaming-responses';
import type { CompactionSessionMeta, FeatureFlags, ProviderFormat, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export interface CompactionParams {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  chatId: string;
  rcWindow: RenderedContext;
  trsWindow: TurnResponse[];
  existingSummary?: string;
  oldCursorMs: number;
  newCursorMs: number;
  reasoningSignatureCompat?: string;
  featureFlags?: FeatureFlags;
  timeoutSec?: number;
  log: Logger;
}

const COMPACT_MAX_TOKENS = 200000;
const MAX_RETRIES = 3;

ensureDumpDir();

const extractResponsesText = (result: { output: unknown[] }): string =>
  result.output
    .filter((item): item is ResponseOutputMessage => (item as { type?: string }).type === 'message')
    .flatMap(item => item.content)
    .filter((block): block is { type: 'output_text'; text: string } => block.type === 'output_text')
    .map(block => block.text)
    .join('');

// Call the LLM (either provider) and extract text content from the response.
const callForText = async (
  params: CompactionParams,
  messages: Message[],
  system: string,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> => {
  if ((params.apiFormat ?? 'openai-chat') === 'responses') {
    const result = await streamingResponses({
      baseURL: params.apiBaseUrl, apiKey: params.apiKey, model: params.model,
      input: messagesToResponsesInput(messages), instructions: system,
      log: params.log, label: `compact:${params.chatId}`, timeoutSec: params.timeoutSec,
    });
    writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));
    const text = extractResponsesText(result);
    return { summary: text, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens };
  }

  const result = await streamingChat({
    baseURL: params.apiBaseUrl, apiKey: params.apiKey, model: params.model,
    messages, system, log: params.log, label: `compact:${params.chatId}`, timeoutSec: params.timeoutSec,
  });
  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));
  const summary = result.choices[0]?.message?.content;
  return {
    summary: typeof summary === 'string' ? summary : '',
    inputTokens: result.usage.prompt_tokens,
    outputTokens: result.usage.completion_tokens,
  };
};

export const runCompaction = async (params: CompactionParams): Promise<CompactionSessionMeta> => {
  const [compactSystemPrompt, compactUserInstruction] = await Promise.all([
    renderCompactionSystemPrompt(),
    renderCompactionUserInstruction(),
  ]);

  const ctx = composeContext(
    params.rcWindow, params.trsWindow, COMPACT_MAX_TOKENS,
    params.reasoningSignatureCompat, params.featureFlags, params.existingSummary,
  );

  const messages: Message[] = [...(ctx?.messages ?? []), { role: 'user', content: compactUserInstruction } as Message];

  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-request.json`, JSON.stringify({
    model: params.model, system: compactSystemPrompt, messages, apiFormat: params.apiFormat ?? 'openai-chat',
  }, null, 2));

  let summary = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    ({ summary, inputTokens, outputTokens } = await callForText(params, messages, compactSystemPrompt));
    if (summary) break;
    params.log.withFields({ chatId: params.chatId, attempt, maxRetries: MAX_RETRIES })
      .warn('Compaction LLM returned empty content, retrying');
  }

  if (!summary)
    throw new Error('compaction produced empty summary');

  return { oldCursorMs: params.oldCursorMs, newCursorMs: params.newCursorMs, summary, inputTokens, outputTokens };
};
