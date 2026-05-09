import { describe, expect, it } from 'vitest';

import { createAgentMailbox } from './mailbox';

const textOf = (entry: ReturnType<ReturnType<typeof createAgentMailbox>['flush']>[number]) => {
  if (entry.kind !== 'message' || entry.role !== 'user') return '';
  return entry.parts.map(p => p.kind === 'text' ? p.text : '').join('\n');
};

describe('createAgentMailbox', () => {
  it('flushes queued messages for one agent in FIFO order', () => {
    const mailbox = createAgentMailbox();
    mailbox.enqueue({ fromAgentId: 'main', toAgentId: 'sa-1', type: 'task', content: 'first' });
    mailbox.enqueue({ fromAgentId: 'main', toAgentId: 'sa-2', type: 'task', content: 'other' });
    mailbox.enqueue({ fromAgentId: 'main', toAgentId: 'sa-1', type: 'status_request', content: 'second' });

    const entries = mailbox.flush('sa-1');
    expect(entries.map(textOf)).toEqual([
      '<agent-message from="main" type="task" final="false">first</agent-message>',
      '<agent-message from="main" type="status_request" final="false">second</agent-message>',
    ]);
    expect(mailbox.flush('sa-1')).toEqual([]);
    expect(mailbox.flush('sa-2').map(textOf)).toEqual([
      '<agent-message from="main" type="task" final="false">other</agent-message>',
    ]);
  });

  it('escapes XML-sensitive message content', () => {
    const mailbox = createAgentMailbox();
    mailbox.enqueue({ fromAgentId: 'sa-1', toAgentId: 'main', type: 'result', content: '<ok>&"', final: true });

    expect(textOf(mailbox.flush('main')[0]!)).toBe(
      '<agent-message from="sa-1" type="result" final="true">&lt;ok&gt;&amp;&quot;</agent-message>',
    );
  });
});
