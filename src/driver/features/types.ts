import type { Logger } from '@guiiai/logg';

import type { ActiveTaskInfo } from '../../background-task/types';
import type { ResolvedChatConfig } from '../../config/config';
import type { RenderedContext } from '../../rendering/types';
import type { createDriverScheduler } from '../scheduler';
import type { SkillInfo } from '../skills';
import type { AgentMailbox } from '../subagents/mailbox';
import type { SubagentManager } from '../subagents/manager';
import type { CahciuaTool, SendMessageTurnFlags } from '../tools';
import type { DriverSignal, TurnCapabilities, TurnState } from '../turn-state';
import type { TurnResponseV2 } from '../types';

export type ReadonlySignal<T> = () => T;

export type MainTurnSchedulerController = Pick<
  ReturnType<typeof createDriverScheduler>,
  'clearAbortController' | 'markFailed' | 'onTurnSettled'
>;

export interface MainTurnFeatureDeps {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  log: Logger;
  rc: ReadonlySignal<RenderedContext>;
  offline: DriverSignal<boolean>;
  running: DriverSignal<boolean>;
  lastProcessedMs: DriverSignal<number>;
  cursorMs: ReadonlySignal<number | undefined>;
  summary: ReadonlySignal<string | undefined>;
  allSkills: Map<string, SkillInfo>;
  mailbox: AgentMailbox;
  subagentManager: SubagentManager;
  loadTRs: (chatId: string, afterMs?: number, agentId?: string) => Promise<TurnResponseV2[]>;
  loadTurnResponses: (chatId: string, afterMs?: number, agentId?: string) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  createCapabilityTools: (
    capabilities: TurnCapabilities,
    reactionEmojis?: string[],
    sendMessageTurnFlags?: SendMessageTurnFlags,
  ) => CahciuaTool[];
  createSendMessageTurnFlags: (turn: TurnState) => SendMessageTurnFlags;
  schedulerController: MainTurnSchedulerController;
  refreshAllowedReactionEmojis?: (chatId: string, signal?: AbortSignal) => Promise<string[]>;
  getAllowedReactionEmojis?: (chatId: string) => string[];
  getActiveBackgroundTasks: (sessionId: string) => ActiveTaskInfo[];
  nowString: () => string;
}
