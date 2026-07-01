import type { SkillInfo } from './skills';
import type { AgentMailbox } from './subagents/mailbox';
import type { SubagentManager } from './subagents/manager';
import type { AgentId } from './subagents/types';
import type { CahciuaTool } from './tools';
import type { CompactionSessionMeta, TurnResponseV2 } from './types';
import type { ResolvedChatConfig } from '../config/config';
import type { LlmEndpoint, Usage } from '../llm/types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

export type DriverSignal<T> = {
  (): T;
  (value: T): void;
};

export interface TurnCapabilities {
  canSendMessage: boolean;
  canDismissMessage: boolean;
  canReact: boolean;
  canUseBash: boolean;
  canUseWebSearch: boolean;
  canUseWebFetch: boolean;
  canDownloadFile: boolean;
  canReadImage: boolean;
  canUseBackgroundTasks: boolean;
  canLoadSkill: boolean;
  canStartSubagent: boolean;
  canMessageSubagent: boolean;
  canMessageMain: boolean;
  canFinalizeSubagent: boolean;
}

export type TurnKind = 'main' | 'subagent';

export const createDefaultTurnCapabilities = (kind: TurnKind): TurnCapabilities => ({
  canSendMessage: kind === 'main',
  canDismissMessage: kind === 'main',
  canReact: kind === 'main',
  canUseBash: true,
  canUseWebSearch: true,
  canUseWebFetch: true,
  canDownloadFile: true,
  canReadImage: true,
  canUseBackgroundTasks: true,
  canLoadSkill: true,
  canStartSubagent: kind === 'main',
  canMessageSubagent: kind === 'main',
  canMessageMain: kind === 'subagent',
  canFinalizeSubagent: kind === 'subagent',
});

export interface SchedulerState {
  debounceTimer?: ReturnType<typeof setTimeout>;
  maxDelayTimer?: ReturnType<typeof setTimeout>;
  debounceWaiting: boolean;
  replyBatchDeadlineMs: number | null;
  startNextDebounceWithExtendDelay: boolean;
  lastTypingAtMs: number;
  activeRunInterruptCursorMs: number;
  activeRunRc: RenderedContext | null;
  activeRunInterruptedByInput: boolean;
  abortController: AbortController | null;
  abortLocked: boolean;
  pendingAbort: boolean;
}

export const createSchedulerState = (): SchedulerState => ({
  debounceWaiting: false,
  replyBatchDeadlineMs: null,
  startNextDebounceWithExtendDelay: false,
  lastTypingAtMs: 0,
  activeRunInterruptCursorMs: 0,
  activeRunRc: null,
  activeRunInterruptedByInput: false,
  abortController: null,
  abortLocked: false,
  pendingAbort: false,
});

export interface ChatScope {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  rc: DriverSignal<RenderedContext>;
  offline: DriverSignal<boolean>;
  running: DriverSignal<boolean>;
  lastProcessedMs: DriverSignal<number>;
  failedRc: DriverSignal<RenderedContext | null>;
  mailbox: AgentMailbox;
  subagents: SubagentManager;
  allSkills: Map<string, SkillInfo>;
  compactionMeta: DriverSignal<CompactionSessionMeta | null>;
  focusMode: DriverSignal<boolean>;
  scheduler: SchedulerState;
  activeTurn: TurnState | null;
  extendDebounce(): void;
  notifyTyping(): void;
  cleanup(): void;
}

export interface TurnState {
  id: string;
  kind: TurnKind;
  chatId: string;
  agentId: AgentId;
  scope: ChatScope;
  model: LlmEndpoint;
  rcAtStart: RenderedContext;
  trs: TurnResponseV2[];
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  step: number;
  maxSteps: number;
  pendingPrune: boolean;
  abortController: AbortController;
  capabilities: TurnCapabilities;
  loadedSkills: Set<string>;
  reactionEmojis: string[];
  flags: {
    wasOfflineAtStart: boolean;
    interruptedByInput: boolean;
    sendMessageWasLengthLimited: boolean;
    modelStayedSilent: boolean;
    inFocusMode: boolean;
  };
}

export interface CompletedStep {
  rawEntries: ConversationEntry[];
  persistedEntries: ConversationEntry[];
  usage: Usage;
  requestedAtMs: number;
  hasToolCalls: boolean;
  anyRequiresFollowUp: boolean;
}
