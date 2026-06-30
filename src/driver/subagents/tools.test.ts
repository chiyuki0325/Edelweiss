import { describe, expect, it, vi } from 'vitest';

import { createAgentMailbox } from './mailbox';
import { createMessageSubagentTool } from './tools';

const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

describe('subagent communication tools', () => {
  it('rejects messages to finalized subagents', async () => {
    const mailbox = createAgentMailbox();
    const wakeAgent = vi.fn();
    const tool = createMessageSubagentTool({
      mailbox,
      wakeAgent,
      getSubagentStatus: () => ({ exists: true, status: 'finalized' }),
      startSubagent: () => ({ ok: false, error: 'unused' }),
      finalizeSubagent: () => {},
      log,
    });

    const result = await tool.execute({ subagent_id: 'sa-1', type: 'status_request', message: 'status?' }, { toolCallId: 'tc1' });
    expect(JSON.parse(result.content as string)).toEqual({ ok: false, error: 'Subagent sa-1 is finalized.' });
    expect(wakeAgent).not.toHaveBeenCalled();
  });

  it('queues messages to active subagents and wakes them', async () => {
    const mailbox = createAgentMailbox();
    const wakeAgent = vi.fn();
    const tool = createMessageSubagentTool({
      mailbox,
      wakeAgent,
      getSubagentStatus: () => ({ exists: true, status: 'idle' }),
      startSubagent: () => ({ ok: false, error: 'unused' }),
      finalizeSubagent: () => {},
      log,
    });

    const result = await tool.execute({ subagent_id: 'sa-1', type: 'status_request', message: 'status?', still_working: true }, { toolCallId: 'tc1' });
    expect(result.requiresFollowUp).toBe(true);
    expect(JSON.parse(result.content as string)).toEqual({ ok: true, queued: true });
    expect(wakeAgent).toHaveBeenCalledWith('sa-1');
    expect(mailbox.hasPending('sa-1')).toBe(true);
  });
});
