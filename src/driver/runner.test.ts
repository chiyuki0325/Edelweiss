import { describe, expect, it } from 'vitest';

import { pruneLengthLimitFailures } from './runner';
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
