import type { Logger } from '@guiiai/logg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLlm: vi.fn(),
}));

vi.mock('./call-llm', () => ({
  callLlm: mocks.callLlm,
}));

import { createRunner, pruneLengthLimitFailures } from './runner';
import { createTool } from './tools';
import type { CahciuaTool, ToolExecutionPolicy } from './tools';
import type { Usage } from '../llm/types';
import type { ConversationEntry } from '../unified-api/types';

const MSG = (overrides: Partial<Extract<ConversationEntry, { kind: 'message' }>> = {}): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [],
  reasoning: undefined,
  ...overrides,
} as ConversationEntry);

const TEXT = (text: string): Extract<Extract<ConversationEntry, { kind: 'message' }>['parts'][number], { kind: 'text' }> => ({
  kind: 'text',
  text,
});

const TC = (name: string, callId: string, args = '{}'): Extract<Extract<ConversationEntry, { kind: 'message' }>['parts'][number], { kind: 'toolCall' }> => ({
  kind: 'toolCall',
  callId,
  name,
  args,
});

const REASONING = (text: string): Extract<Extract<ConversationEntry, { kind: 'message' }>['parts'][number], { kind: 'reasoning' }> => ({
  kind: 'reasoning',
  data: { source: 'openaiChatCompletion' as const, data: { type: 'thinking' as const, thinking: text, signature: '' } },
} as Extract<Extract<ConversationEntry, { kind: 'message' }>['parts'][number], { kind: 'reasoning' }>);

const TR = (callId: string, payload: string, requiresFollowUp = true): ConversationEntry => ({
  kind: 'toolResult',
  callId,
  payload,
  requiresFollowUp,
});

const LENGTH_ERROR = JSON.stringify({ ok: false, error: 'Message is too long, try reduce sentence length or split into multiple messages. If you need to quote a large block of text verbatim, use a blockquote (> ) or code block (```).' });
const OK_RESULT = JSON.stringify({ ok: true, message_id: '42' });
const OTHER_ERROR = JSON.stringify({ ok: false, error: 'Some other error' });

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

beforeEach(() => {
  mocks.callLlm.mockReset();
});

describe('runOneStep', () => {
  it('combines model output with executed tool results', async () => {
    const assistantMessage = MSG({ parts: [TC('test_tool', 'tc1', '{"value":1}')] });
    mocks.callLlm.mockResolvedValueOnce({
      entries: [assistantMessage],
      usage,
    });

    const tool: CahciuaTool = {
      type: 'function',
      function: {
        name: 'test_tool',
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
      },
      validate: () => ({ valid: true, errors: [] }),
      execute: vi.fn(() => ({ content: 'tool ok', requiresFollowUp: false })),
    };

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

    expect(mocks.callLlm).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model' }),
      [],
      'system',
      [expect.objectContaining({ name: 'test_tool' })],
      expect.objectContaining({ label: 'step:1', dumpId: 'chat' }),
    );
    expect(tool.execute).toHaveBeenCalledWith({ value: 1 }, { toolCallId: 'tc1' });
    expect(step).toMatchObject({
      usage,
      hasToolCalls: true,
      stepEntries: [
        assistantMessage,
        {
          kind: 'toolResult',
          callId: 'tc1',
          payload: 'tool ok',
          requiresFollowUp: false,
        },
      ],
    });
  });
});

describe('executeToolStep scheduling', () => {
  const runner = createRunner({
    apiBaseUrl: 'https://llm.example.test',
    apiKey: 'test-key',
    model: 'test-model',
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  };
  const scheduledTool = (
    name: string,
    execution: ToolExecutionPolicy,
    execute: CahciuaTool['execute'],
  ): CahciuaTool => createTool({
    name,
    execution,
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        attachments: { type: 'array' },
        path: { type: 'string' },
      },
      required: ['label'],
    },
    execute,
  });

  it('settles prelude calls before starting other lanes', async () => {
    const preludeGate = deferred();
    const events: string[] = [];
    const prelude = scheduledTool('focus', { lane: 'prelude' }, async () => {
      events.push('focus:start');
      await preludeGate.promise;
      events.push('focus:end');
      return { content: 'focus', requiresFollowUp: true };
    });
    const read = scheduledTool('read', { lane: 'readonly' }, () => {
      events.push('read:start');
      return { content: 'read', requiresFollowUp: true };
    });

    const pending = runner.executeToolStep([
      TC('read', 'read-call', '{"label":"read"}'),
      TC('focus', 'focus-call', '{"label":"focus"}'),
    ], { chatId: 'chat', system: 'system', tools: [prelude, read], log });

    await vi.waitFor(() => expect(events).toEqual(['focus:start']));
    preludeGate.resolve();
    const results = await pending;

    expect(events).toEqual(['focus:start', 'focus:end', 'read:start']);
    expect(results.map(result => result.callId)).toEqual(['read-call', 'focus-call']);
  });

  it('runs readonly calls concurrently while preserving result order', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const events: string[] = [];
    const read = scheduledTool('read', { lane: 'readonly' }, async input => {
      const { label } = input as { label: string };
      events.push(`${label}:start`);
      await (label === 'first' ? firstGate.promise : secondGate.promise);
      events.push(`${label}:end`);
      return { content: label, requiresFollowUp: true };
    });

    const pending = runner.executeToolStep([
      TC('read', 'first-call', '{"label":"first"}'),
      TC('read', 'second-call', '{"label":"second"}'),
    ], { chatId: 'chat', system: 'system', tools: [read], log });

    await vi.waitFor(() => expect(events).toEqual(['first:start', 'second:start']));
    secondGate.resolve();
    await vi.waitFor(() => expect(events).toContain('second:end'));
    firstGate.resolve();
    const results = await pending;

    expect(results.map(result => result.callId)).toEqual(['first-call', 'second-call']);
  });

  it('serializes workspace writers', async () => {
    const firstGate = deferred();
    const events: string[] = [];
    const writer = scheduledTool('writer', { lane: 'writer' }, async input => {
      const { label } = input as { label: string };
      events.push(`${label}:start`);
      if (label === 'first') await firstGate.promise;
      events.push(`${label}:end`);
      return { content: label, requiresFollowUp: true };
    });

    const pending = runner.executeToolStep([
      TC('writer', 'first-call', '{"label":"first"}'),
      TC('writer', 'second-call', '{"label":"second"}'),
    ], { chatId: 'chat', system: 'system', tools: [writer], log });

    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    firstGate.resolve();
    await pending;

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('runs writers and messages in FIFO lanes and blocks attachments on writers', async () => {
    const writerGate = deferred();
    const firstMessageGate = deferred();
    const attachmentGate = deferred();
    const events: string[] = [];
    const writer = scheduledTool('writer', { lane: 'writer' }, async () => {
      events.push('writer:start');
      await writerGate.promise;
      events.push('writer:end');
      return { content: 'writer', requiresFollowUp: true };
    });
    const read = scheduledTool('read', { lane: 'readonly' }, () => {
      events.push('read:start');
      return { content: 'read', requiresFollowUp: true };
    });
    const message = scheduledTool('message', {
      lane: 'message',
      waitForWriters: input => Array.isArray((input as { attachments?: unknown[] }).attachments),
    }, async input => {
      const { label } = input as { label: string };
      events.push(`${label}:start`);
      if (label === 'plain-before') await firstMessageGate.promise;
      if (label === 'attachment') await attachmentGate.promise;
      events.push(`${label}:end`);
      return { content: label, requiresFollowUp: false };
    });

    const pending = runner.executeToolStep([
      TC('writer', 'writer-call', '{"label":"writer"}'),
      TC('message', 'plain-before-call', '{"label":"plain-before"}'),
      TC('read', 'read-call', '{"label":"read"}'),
      TC('message', 'attachment-call', '{"label":"attachment","attachments":[]}'),
      TC('message', 'plain-after-call', '{"label":"plain-after"}'),
    ], { chatId: 'chat', system: 'system', tools: [writer, read, message], log });

    await vi.waitFor(() => {
      expect(events).toContain('writer:start');
      expect(events).toContain('read:start');
      expect(events).toContain('plain-before:start');
    });
    expect(events).not.toContain('attachment:start');
    firstMessageGate.resolve();
    await vi.waitFor(() => expect(events).toContain('plain-before:end'));
    expect(events).not.toContain('attachment:start');
    writerGate.resolve();
    await vi.waitFor(() => expect(events).toContain('attachment:start'));
    expect(events).not.toContain('plain-after:start');
    attachmentGate.resolve();
    const results = await pending;

    expect(events.indexOf('writer:end')).toBeLessThan(events.indexOf('attachment:start'));
    expect(events.indexOf('attachment:end')).toBeLessThan(events.indexOf('plain-after:start'));
    expect(results.map(result => result.callId)).toEqual([
      'writer-call',
      'plain-before-call',
      'read-call',
      'attachment-call',
      'plain-after-call',
    ]);
  });

  it('releases the writer barrier after a writer failure', async () => {
    const events: string[] = [];
    const writer = scheduledTool('writer', { lane: 'writer' }, () => {
      events.push('writer:start');
      throw new Error('write failed');
    });
    const localRead = scheduledTool('local-read', {
      lane: 'readonly',
      waitForWriters: input => Boolean((input as { path?: string }).path),
    }, () => {
      events.push('read:start');
      return { content: 'read', requiresFollowUp: true };
    });

    const results = await runner.executeToolStep([
      TC('writer', 'writer-call', '{"label":"writer"}'),
      TC('local-read', 'read-call', '{"label":"read","path":"image.png"}'),
    ], { chatId: 'chat', system: 'system', tools: [writer, localRead], log });

    expect(events).toEqual(['writer:start', 'read:start']);
    expect(results[0]?.payload).toContain('write failed');
    expect(results[1]?.payload).toBe('read');
  });
});

describe('pruneLengthLimitFailures', () => {
  it('passes through entries unchanged when no failures and not pending', () => {
    const entries: ConversationEntry[] = [
      MSG({ parts: [TEXT('hello'), TC('send_message', 'tc1')] }),
      TR('tc1', OK_RESULT, false),
    ];

    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, false);

    expect(pruned).toEqual(entries);
    expect(pendingPrune).toBe(false);
  });

  it('removes failed ToolCallPart, its ToolResult, and thinking content from the same OutputMessage', () => {
    const entries: ConversationEntry[] = [
      MSG({ parts: [TEXT('Let me write a long message'), TC('send_message', 'tc1')] }),
      TR('tc1', LENGTH_ERROR, true),
    ];

    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, false);

    // Thinking and failed call removed; OutputMessage becomes empty → filtered out
    expect(pruned).toHaveLength(0);
    expect(pendingPrune).toBe(true);
  });

  it('preserves non-send_message ToolCallParts when pruning thinking content', () => {
    const entries: ConversationEntry[] = [
      MSG({ parts: [TEXT('pre-thinking'), TC('bash', 'tc_bash', '{"command":"echo hi"}'), TC('send_message', 'tc1')] }),
      TR('tc1', LENGTH_ERROR, true),
      TR('tc_bash', '{"exit_code":0}', true),
    ];

    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, false);

    expect(pendingPrune).toBe(true);
    // Bash ToolCallPart should be kept, send_message TC and its TR removed, thinking removed
    const msg = pruned.find(e => e.kind === 'message' && e.role === 'assistant');
    expect(msg).toBeDefined();
    const parts = (msg as Extract<ConversationEntry, { kind: 'message' }>).parts;
    expect(parts).toHaveLength(1);
    expect(parts![0]!.kind).toBe('toolCall');
    expect((parts![0] as { name: string }).name).toBe('bash');
    // Bash TR should still be present
    expect(pruned.some(e => e.kind === 'toolResult' && e.callId === 'tc_bash')).toBe(true);
    // send_message TR should be removed
    expect(pruned.some(e => e.kind === 'toolResult' && e.callId === 'tc1')).toBe(false);
  });

  it('does not affect non-length-limit errors', () => {
    const entries: ConversationEntry[] = [
      MSG({ parts: [TEXT('trying'), TC('send_message', 'tc1')] }),
      TR('tc1', OTHER_ERROR, true),
    ];

    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, false);

    // Other errors pass through unchanged
    expect(pruned).toHaveLength(2);
    expect(pendingPrune).toBe(false);
  });

  it('removes orphaned ToolResult when no matching ToolCallPart found', () => {
    const entries: ConversationEntry[] = [
      TR('tc_orphan', LENGTH_ERROR, true),
    ];

    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, false);

    expect(pruned).toHaveLength(0);
    expect(pendingPrune).toBe(true);
  });

  describe('cross-step pendingPrune', () => {
    it('removes thinking before the first send_message when pendingPrune is set', () => {
      // Simulates step N+1 after a length-limit failure in step N
      const entries: ConversationEntry[] = [
        MSG({ parts: [TEXT('I need to split this'), REASONING('splitting is better'), TC('send_message', 'tc2', '{"text":"part 1"}'), TC('send_message', 'tc3', '{"text":"part 2"}')] }),
        TR('tc2', OK_RESULT, false),
        TR('tc3', OK_RESULT, false),
      ];

      const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, true);

      expect(pendingPrune).toBe(false); // cleared after seeing successful send_message
      const msg = pruned.find(e => e.kind === 'message' && e.role === 'assistant');
      expect(msg).toBeDefined();
      const parts = (msg as Extract<ConversationEntry, { kind: 'message' }>).parts;
      // TextPart and ReasoningPart before first send_message should be removed
      expect(parts).toHaveLength(2); // only the two ToolCallParts remain
      expect(parts!.every(p => p.kind === 'toolCall')).toBe(true);
    });

    it('clears pendingPrune only when a send_message ToolCallPart is found', () => {
      const entries: ConversationEntry[] = [
        MSG({ parts: [TEXT('just thinking'), TC('bash', 'tc_bash')] }),
        TR('tc_bash', '{"exit_code":0}', true),
      ];

      const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, true);

      // No send_message in this step — pendingPrune should persist
      expect(pendingPrune).toBe(true);
      // But bash TC and its thinking should be preserved (we only prune before send_message)
      const msg = pruned.find(e => e.kind === 'message' && e.role === 'assistant');
      expect(msg).toBeDefined();
      const parts = (msg as Extract<ConversationEntry, { kind: 'message' }>).parts;
      expect(parts).toHaveLength(2); // TextPart + bash TC preserved
    });
  });

  describe('cleanup', () => {
    it('removes OutputMessages that become empty after pruning', () => {
      const entries: ConversationEntry[] = [
        MSG({ parts: [TEXT('thinking')] }), // no tool calls — would only be pruned if pendingPrune, but let's test the failed-prune path
        MSG({ parts: [TC('send_message', 'tc1')] }),
        TR('tc1', LENGTH_ERROR, true),
      ];

      const { pruned } = pruneLengthLimitFailures(entries, false);

      // First MSG should be preserved (it wasn't involved in the failure)
      // But actually: we remove ALL TextPart/ReasoningPart from the OutputMessage that contains the failed call
      // The failed call's OutputMessage had only the TC → after removal, empty → filtered
      // The first MSG is untouched
      expect(pruned).toHaveLength(1);
      expect(pruned[0]!.kind).toBe('message');
    });

    it('clears message-level reasoning when pruning a failure', () => {
      const entries: ConversationEntry[] = [
        MSG({
          parts: [TC('send_message', 'tc1')],
          reasoning: { reasoning_text: 'some reasoning' },
        }),
        TR('tc1', LENGTH_ERROR, true),
      ];

      const { pruned } = pruneLengthLimitFailures(entries, false);

      // OutputMessage had only the TC + reasoning → after pruning parts → reasoning explicitly cleared
      // The message should be gone since parts are empty and reasoning was cleared
      expect(pruned).toHaveLength(0);
    });
  });
});
