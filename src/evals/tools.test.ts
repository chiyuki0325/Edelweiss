import { describe, expect, it } from 'vitest';

import { createEvalTools } from './tools';
import { executeToolCall } from '../driver/tools';

const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

describe('createEvalTools', () => {
  it('captures send_message without platform side effects', async () => {
    const { tools, trace } = createEvalTools();
    const result = await executeToolCall(
      'tc1',
      'send_message',
      JSON.stringify({ text: 'hello', await_response: false }),
      tools,
      log,
    );

    expect(JSON.parse(result.payload as string)).toEqual({ ok: true, message_id: 'eval-1' });
    expect(result.requiresFollowUp).toBe(false);
    expect(trace.sentMessages).toHaveLength(1);
    expect(trace.sentMessages[0]!.messageId).toBe('eval-1');
    expect(trace.sentMessages[0]!.text.trim()).toBe('hello');
  });

  it('omits load_skill when no skills folder is configured', () => {
    const { tools } = createEvalTools();
    expect(tools.map(t => t.function.name)).toEqual(['send_message', 'dismiss_message']);
  });
});
