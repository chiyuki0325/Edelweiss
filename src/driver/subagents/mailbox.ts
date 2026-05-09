import type { AgentId, AgentMessage, AgentMessageType } from './types';
import type { ConversationEntry } from '../../unified-api/types';

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const messageToEntry = (msg: AgentMessage): ConversationEntry => ({
  kind: 'message',
  role: 'user',
  parts: [{
    kind: 'text',
    text: `<agent-message from="${escapeXml(msg.fromAgentId)}" type="${escapeXml(msg.type)}" final="${msg.final ? 'true' : 'false'}">${escapeXml(msg.content)}</agent-message>`,
  }],
});

export const createAgentMailbox = () => {
  let nextId = 1;
  const pending = new Map<AgentId, AgentMessage[]>();

  const enqueue = (message: {
    fromAgentId: AgentId;
    toAgentId: AgentId;
    type: AgentMessageType;
    content: string;
    final?: boolean;
  }): AgentMessage => {
    const msg: AgentMessage = {
      id: nextId++,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      type: message.type,
      content: message.content,
      final: message.final ?? false,
      createdAtMs: Date.now(),
    };
    pending.set(msg.toAgentId, [...(pending.get(msg.toAgentId) ?? []), msg]);
    return msg;
  };

  const flush = (agentId: AgentId): ConversationEntry[] => {
    const messages = pending.get(agentId) ?? [];
    pending.delete(agentId);
    return messages.map(messageToEntry);
  };

  const hasPending = (agentId: AgentId): boolean => (pending.get(agentId)?.length ?? 0) > 0;

  return { enqueue, flush, hasPending };
};

export type AgentMailbox = ReturnType<typeof createAgentMailbox>;
