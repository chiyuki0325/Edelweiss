import type { Logger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callLlm } from './call-llm';

const makeLog = (): Logger => {
  const log = {
    withFields: () => log,
    withError: () => log,
    log: () => {},
    error: () => {},
  };
  return log as unknown as Logger;
};

const sseStream = (...events: unknown[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callLlm', () => {
  it('maps OpenAI-compatible prompt cache hit and miss tokens into usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream(
      {
        choices: [{
          finish_reason: 'stop',
          delta: { content: 'ok' },
        }],
      },
      {
        usage: {
          prompt_tokens: 45439,
          completion_tokens: 301,
          prompt_tokens_details: { cached_tokens: 44032 },
          prompt_cache_hit_tokens: 44032,
          prompt_cache_miss_tokens: 1407,
        },
      },
    ))));

    const result = await callLlm(
      {
        apiBaseUrl: 'https://llm.example.test',
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        apiFormat: 'openai-chat',
      },
      [],
      'system',
      undefined,
      { log: makeLog(), label: 'test' },
    );

    expect(result.usage).toEqual({
      inputTokens: 45439,
      outputTokens: 301,
      cacheCreationTokens: 1407,
      cacheReadTokens: 44032,
    });
  });
});
