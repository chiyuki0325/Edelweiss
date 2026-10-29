import type { Logger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callLlm } from './call-llm';

const log = {
  withFields: () => log,
  withError: () => log,
  log: () => {},
  error: () => {},
} as unknown as Logger;

const options = () => ({ log, label: 'test' });

const stream = (...lines: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines)
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.close();
    },
  });
};

const emptyStream = () => stream('[DONE]');

const chatStream = (content = 'ok', usage: Record<string, unknown> = {
  prompt_tokens: 2,
  completion_tokens: 1,
  total_tokens: 3,
}): ReadableStream<Uint8Array> => stream(
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [],
    usage,
  }),
  '[DONE]',
);

const chatToolStream = (): ReadableStream<Uint8Array> => stream(
  JSON.stringify({
    id: 'chatcmpl-tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'send_message', arguments: '{}' },
        }],
      },
      finish_reason: null,
    }],
  }),
  JSON.stringify({
    id: 'chatcmpl-tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }),
  '[DONE]',
);

const requestBody = (mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> =>
  JSON.parse((mock.mock.calls[index]![1] as { body: string }).body) as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe('callLlm through LangChain', () => {
  it('maps OpenAI streaming usage and cache details', async () => {
    const fetchMock = vi.fn(async () => new Response(chatStream('ok', {
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
    })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      apiFormat: 'openai-chat',
    }, [], 'system', undefined, options());

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheCreationTokens: 3,
      cacheReadTokens: 7,
    });
    expect(result.entries[0]!.text).toBe('ok');
  });

  it.each([
    ['openai-chat', '/chat/completions', 'none'],
    ['responses', '/responses', 'none'],
    ['anthropic-messages', '/messages', { type: 'none' }],
  ] as const)('routes %s and applies tool choice', async (apiFormat, suffix, expectedChoice) => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(emptyStream()));
    vi.stubGlobal('fetch', fetchMock);

    await callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      apiFormat,
      toolChoice: 'force',
    }, [], 'system', [{
      name: 'send_message',
      parameters: { type: 'object', properties: {} },
    }], { ...options(), toolChoice: 'none' });

    expect(String(fetchMock.mock.calls[0]![0])).toContain(suffix);
    expect(requestBody(fetchMock).tool_choice).toEqual(expectedChoice);
  });

  it('maps force to the Responses API required policy', async () => {
    const fetchMock = vi.fn(async () => new Response(emptyStream()));
    vi.stubGlobal('fetch', fetchMock);
    await callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      apiFormat: 'responses',
      toolChoice: 'force',
    }, [], 'system', [{
      name: 'send_message',
      parameters: { type: 'object', properties: {} },
    }], options());
    expect(requestBody(fetchMock).tool_choice).toBe('required');
  });

  it('retries local-force without mutating the input messages', async () => {
    const fetchMock = vi.fn(async () => new Response(chatStream()));
    vi.stubGlobal('fetch', fetchMock);
    const entries: Parameters<typeof callLlm>[1] = [];
    await callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      toolChoice: 'local-force',
      localForceMaxRetries: 2,
    }, entries, 'system', undefined, options());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(entries).toEqual([]);
  });

  it('aborts local-none on a tool-call chunk and adds a private retry reminder', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      return new Response(attempt === 1 ? chatToolStream() : chatStream());
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      toolChoice: 'local-none',
    }, [], 'system', [{
      name: 'send_message',
      parameters: { type: 'object', properties: {} },
    }], options());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requestBody(fetchMock, 1))).toContain('DO NOT CALL ANY TOOLS.');
  });

  it('propagates external cancellation while reading a stream', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const pending = callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      signal: controller.signal,
    }, [], 'system', undefined, options());
    setImmediate(() => controller.abort(new Error('cancelled')));
    await expect(pending).rejects.toThrow('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not policy-retry transport errors', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network failed'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLlm({
      apiBaseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'test',
      toolChoice: 'local-none',
    }, [], 'system', undefined, options())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
