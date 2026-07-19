import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from '../tools';
import { createTool } from '../tools';
import type { AgentMailbox } from './mailbox';
import type { AgentId, AgentMessageType } from './types';
import { isSubagentId } from './types';

interface ToolDeps {
  mailbox: AgentMailbox;
  wakeAgent: (agentId: AgentId) => void;
  getSubagentStatus: (agentId: AgentId) => { exists: boolean; status?: string };
  startSubagent: (task: string, context: string | undefined, expectedOutput: string | undefined) => { ok: true; id: AgentId } | { ok: false; error: string };
  finalizeSubagent: (agentId: AgentId, message: string) => void;
  log: Logger;
}

const messageTypeEnum = ['status_request', 'status_reply', 'progress', 'result', 'error'] as const;

export const createStartSubagentTool = (deps: ToolDeps): CahciuaTool => createTool({
  name: 'start_subagent',
  execution: { lane: 'serial' },
  description: 'Start an isolated helper agent for a non-trivial investigation or tool-heavy task. Use this only when delegation will keep your own context cleaner than doing the work directly.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Concrete task for the helper agent.' },
      context: { type: 'string', description: 'Brief relevant context for the task. Include only what the helper needs.' },
      expected_output: { type: 'string', description: 'The desired shape of the helper result.' },
    },
    required: ['task'],
  },
  execute: input => {
    const { task, context, expected_output } = input as { task: string; context?: string; expected_output?: string };
    const result = deps.startSubagent(task, context, expected_output);
    if (!result.ok) return { content: JSON.stringify(result), requiresFollowUp: true };
    deps.log.withFields({ subagentId: result.id }).log('Subagent started');
    return { content: JSON.stringify({ ok: true, subagent_id: result.id, status: 'running' }), requiresFollowUp: true };
  },
});

export const createMessageSubagentTool = (deps: ToolDeps): CahciuaTool => createTool({
  name: 'message_subagent',
  execution: { lane: 'serial' },
  description: 'Send a short instruction or status request to an active helper agent.',
  parameters: {
    type: 'object',
    properties: {
      subagent_id: { type: 'string', description: 'The helper agent id, such as sa-1.' },
      type: { type: 'string', enum: messageTypeEnum },
      message: { type: 'string' },
      still_working: { type: 'boolean', description: 'Set true if you are still working and need to continue after the helper responds. Defaults to false.' },
    },
    required: ['subagent_id', 'type', 'message'],
  },
  execute: input => {
    const { subagent_id, type, message, still_working } = input as {
      subagent_id: string;
      type: AgentMessageType;
      message: string;
      still_working?: boolean;
    };
    if (!isSubagentId(subagent_id))
      return { content: JSON.stringify({ ok: false, error: 'Invalid subagent_id.' }), requiresFollowUp: true };
    const status = deps.getSubagentStatus(subagent_id);
    if (!status.exists)
      return { content: JSON.stringify({ ok: false, error: `Unknown subagent: ${subagent_id}` }), requiresFollowUp: true };
    if (status.status === 'finalized' || status.status === 'failed')
      return { content: JSON.stringify({ ok: false, error: `Subagent ${subagent_id} is ${status.status}.` }), requiresFollowUp: true };
    deps.mailbox.enqueue({ fromAgentId: 'main', toAgentId: subagent_id, type, content: message });
    deps.wakeAgent(subagent_id);
    return { content: JSON.stringify({ ok: true, queued: true }), requiresFollowUp: still_working ?? false };
  },
});

export const createMessageMainTool = (deps: ToolDeps, subagentId: AgentId): CahciuaTool => createTool({
  name: 'message_main',
  execution: { lane: 'serial' },
  description: 'Send a short progress update or answer to the parent agent.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: messageTypeEnum },
      message: { type: 'string' },
      still_working: { type: 'boolean', description: 'Set true if you are still working and need the parent to reply before continuing. Defaults to false.' },
    },
    required: ['type', 'message'],
  },
  execute: input => {
    const { type, message, still_working } = input as { type: AgentMessageType; message: string; still_working?: boolean };
    deps.mailbox.enqueue({ fromAgentId: subagentId, toAgentId: 'main', type, content: message });
    deps.wakeAgent('main');
    return { content: JSON.stringify({ ok: true, queued: true }), requiresFollowUp: still_working ?? false };
  },
});

export const createFinalizeSubagentTool = (deps: ToolDeps, subagentId: AgentId): CahciuaTool => createTool({
  name: 'finalize_subagent',
  execution: { lane: 'serial' },
  description: 'Finish this assigned task and return the final result to the parent agent.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Concise final result for the parent agent.' },
      result: { description: 'Optional structured result data.' },
    },
    required: ['message'],
  },
  execute: input => {
    const { message, result } = input as { message: string; result?: unknown };
    const content = result == null ? message : `${message}\n\n${JSON.stringify(result)}`;
    deps.mailbox.enqueue({ fromAgentId: subagentId, toAgentId: 'main', type: 'result', content, final: true });
    deps.finalizeSubagent(subagentId, message);
    deps.wakeAgent('main');
    return { content: JSON.stringify({ ok: true, finalized: true }), requiresFollowUp: false };
  },
});
