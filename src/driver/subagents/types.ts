import type { ConversationEntry } from '../../unified-api/types';

export type AgentId = 'main' | `sa-${number}`;
export type SubagentStatus = 'running' | 'idle' | 'finalized' | 'failed';

export type AgentMessageType = 'task' | 'status_request' | 'status_reply' | 'progress' | 'result' | 'error';

export interface AgentMessage {
  id: number;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  type: AgentMessageType;
  content: string;
  createdAtMs: number;
  final: boolean;
}

export interface SubagentState {
  id: AgentId;
  task: string;
  context?: string;
  expectedOutput?: string;
  status: SubagentStatus;
  createdAtMs: number;
  updatedAtMs: number;
  finalMessage?: string;
  entries: ConversationEntry[];
  running: boolean;
  wakeRequested: boolean;
}

export const isSubagentId = (id: string): id is `sa-${number}` => /^sa-\d+$/.test(id);
