import type { Logger } from '@guiiai/logg';
import { isAIMessage, isToolMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ callLlm: vi.fn() }));

vi.mock('./call-llm', () => ({ callLlm: mocks.callLlm }));

import { aiMessage, messageText, toolMessage, type DriverMessage, type DriverToolCall } from './messages';
import { createRunner, pruneLengthLimitFailures } from './runner';
import { createTool } from './tools';
import type { CahciuaTool } from './tools';
import type { Usage } from '../llm/types';

const call = (name: string, id: string, args: Record<string, unknown> = {}): DriverToolCall =>
  ({ name, id, args });

const assistant = (
  content: string,
  calls: DriverToolCall[] = [],
): DriverMessage => aiMessage({ content, tool_calls: calls });

const result = (id: string, content: string, requiresFollowUp = true): DriverMessage =>
  toolMessage(id, content, requiresFollowUp);

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: -1,
  cacheReadTokens: -1,
};

const log = {
  withFields: () => log,
  withError: () => log,
  log: () => {},
  error: () => {},
} as unknown as Logger;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => mocks.callLlm.mockReset());

describe('createRunner', () => {
  it('combines LangChain model output with executed ToolMessages', async () => {
    const modelMessage = assistant('', [call('test_tool', 'tc1', { value: 1 })]);
    mocks.callLlm.mockResolvedValueOnce({ entries: [modelMessage], usage });
    const tool: CahciuaTool = createTool({
      name: 'test_tool',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: vi.fn(() => ({ content: 'tool ok', requiresFollowUp: false })),
    });
    const runner = createRunner({
      apiBaseUrl: 'https://llm.example.test',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const step = await runner.runOneStep([], {
      chatId: 'chat',
      system: 'system',
      tools: [tool],
      log,
    }, 1);

    expect(tool.execute).toHaveBeenCalledWith({ value: 1 }, { toolCallId: 'tc1' });
    expect(step.hasToolCalls).toBe(true);
    expect(step.stepEntries[0]).toBe(modelMessage);
    expect(isToolMessage(step.stepEntries[1])).toBe(true);
    expect(messageText(step.stepEntries[1]!)).toBe('tool ok');
  });

  it('runs readonly tools concurrently and preserves call order', async () => {
    const gates = [deferred(), deferred()];
    const events: string[] = [];
    const read = createTool({
      name: 'read',
      execution: { lane: 'readonly' },
      parameters: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index'],
      },
      execute: async input => {
        const index = (input as { index: number }).index;
        events.push(`start:${index}`);
        await gates[index]!.promise;
        return { content: String(index), requiresFollowUp: true };
      },
    });
    const runner = createRunner({
      apiBaseUrl: 'https://llm.example.test',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const pending = runner.executeToolStep([
      call('read', 'first', { index: 0 }),
      call('read', 'second', { index: 1 }),
    ], { chatId: 'chat', system: 'system', tools: [read], log });
    await vi.waitFor(() => expect(events).toEqual(['start:0', 'start:1']));
    gates[1]!.resolve();
    gates[0]!.resolve();
    const results = await pending;

    expect(results.map(message => message.tool_call_id)).toEqual(['first', 'second']);
  });

  it('serializes writer tools', async () => {
    const gate = deferred();
    const events: string[] = [];
    const writer = createTool({
      name: 'write',
      execution: { lane: 'writer' },
      parameters: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index'],
      },
      execute: async input => {
        const index = (input as { index: number }).index;
        events.push(`start:${index}`);
        if (index === 0) await gate.promise;
        events.push(`end:${index}`);
        return { content: String(index), requiresFollowUp: true };
      },
    });
    const runner = createRunner({
      apiBaseUrl: 'https://llm.example.test',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const pending = runner.executeToolStep([
      call('write', 'first', { index: 0 }),
      call('write', 'second', { index: 1 }),
    ], { chatId: 'chat', system: 'system', tools: [writer], log });
    await vi.waitFor(() => expect(events).toEqual(['start:0']));
    gate.resolve();
    await pending;
    expect(events).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
  });
});

describe('pruneLengthLimitFailures', () => {
  const lengthError = JSON.stringify({ ok: false, error: 'Message is too long' });

  it('removes a failed send_message call and its ToolMessage', () => {
    const entries = [
      assistant('draft', [call('send_message', 'send')]),
      result('send', lengthError),
    ];
    expect(pruneLengthLimitFailures(entries, false)).toEqual({
      pruned: [],
      pendingPrune: true,
    });
  });

  it('keeps unrelated tool calls and results', () => {
    const entries = [
      assistant('draft', [call('bash', 'bash'), call('send_message', 'send')]),
      result('send', lengthError),
      result('bash', '{"ok":true}'),
    ];
    const { pruned } = pruneLengthLimitFailures(entries, false);
    const model = pruned.find(isAIMessage);
    expect(model?.tool_calls?.map(item => item.name)).toEqual(['bash']);
    expect(pruned.some(entry => isToolMessage(entry) && entry.tool_call_id === 'bash')).toBe(true);
  });

  it('clears prior draft text when a later send_message resolves the retry', () => {
    const entries = [
      assistant('split this', [call('send_message', 'send')]),
      result('send', '{"ok":true}', false),
    ];
    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, true);
    expect(pendingPrune).toBe(false);
    expect(messageText(pruned[0]!)).toBe('');
  });

  it('does not prune unrelated errors', () => {
    const entries = [
      assistant('draft', [call('send_message', 'send')]),
      result('send', JSON.stringify({ ok: false, error: 'network failed' })),
    ];
    expect(pruneLengthLimitFailures(entries, false).pruned).toHaveLength(2);
  });
});
