import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, wasToolLoopInterrupted } from './context';
import { createMainTurnFeatures } from './features/main';
import { renderSubagentSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { createDriverScheduler } from './scheduler';
import { loadSkillsFromFolder } from './skills';
import { createAgentMailbox } from './subagents/mailbox';
import { createSubagentManager } from './subagents/manager';
import { createToolsForCapabilities } from './tool-providers';
import type { CapabilityToolProviderDeps } from './tool-providers';
import type { CahciuaTool, SendMessageAttachment, SendMessageTurnFlags } from './tools';
import { TurnPreparationSkipped } from './turn-features';
import type { DriverFeature } from './turn-features';
import { createTurnPhases, runTurn } from './turn-phases';
import { createDefaultTurnCapabilities, createSchedulerState } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';
import type { CompactionSessionMeta, DriverConfig, ManualCompactionResult, PlatformAdapter, TurnResponseV2 } from './types';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { RenderedContext } from '../rendering/types';
import type { Attachment } from '../telegram/message/types';

/** Format current time in local timezone as ISO 8601 with offset (e.g. 2025-03-13T22:30:00+08:00). */
const localTimeNow = (): string => {
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return `${iso}${tz}`;
};

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSubagentSystemPrompt, renderSystemPrompt } from './prompt';
export type { DriverConfig } from './types';
export type { TurnResponseV2 } from './types';
export type { ProviderFormat } from '../llm/types';

const MAX_STEPS = Infinity;

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number, agentId?: string) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number, attachments?: SendMessageAttachment[]) => Promise<{ messageId: number; date: number }>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
  runtimeConfig: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  refreshAllowedReactionEmojis?: (chatId: string, signal?: AbortSignal) => Promise<string[]>;
  getAllowedReactionEmojis?: (chatId: string) => string[];
  sendReaction?: (chatId: string, messageId: number, emoji: string) => Promise<void>;
  resolveModel: (name: string) => LlmEndpoint;
  backgroundTask: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    getActiveTasks: (sessionId: string) => ActiveTaskInfo[];
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  getPlatformAdapter?: (chatId: string) => PlatformAdapter | undefined;
  getChatName?: (chatId: string) => Promise<string>;
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void;
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  // Runner cache: keyed by "apiBaseUrl::model" to reuse runners across chats
  // sharing the same endpoint.
  const runners = new Map<string, ReturnType<typeof createRunner>>();
  const getOrCreateRunner = (endpoint: LlmEndpoint) => {
    const key = `${endpoint.apiBaseUrl}::${endpoint.model}`;
    let runner = runners.get(key);
    if (!runner) {
      runner = createRunner({
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        apiFormat: endpoint.apiFormat ?? 'openai-chat',
        timeoutSec: endpoint.timeoutSec,
        extraBody: endpoint.extraBody,
        forceToolCall: endpoint.forceToolCall,
      });
      runners.set(key, runner);
    }
    return runner;
  };

  const loadTRs = (chatId: string, afterMs?: number, agentId = 'main'): Promise<TurnResponseV2[]> =>
    deps.loadTurnResponses(chatId, afterMs, agentId);

  const getLastProcessedTime = async (chatId: string): Promise<number> => {
    const trs = await deps.loadTurnResponses(chatId);
    return trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
  };

  const chatScopes = new Map<string, ChatScope>();
  const manualCompactionRequests = new Map<string, () => Promise<ManualCompactionResult>>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    // Resolve per-chat config once per scope
    const chatConfig = config.resolveChatConfig(chatId);
    let chatName: Promise<string> | undefined;
    const getChatName = () => {
      chatName ??= (deps.getChatName?.(chatId) ?? Promise.resolve(chatId))
        .catch(err => {
          log.withError(err).withFields({ chatId }).warn('Failed to resolve chat name; using chat id');
          return chatId;
        });
      return chatName;
    };

    const rc = signal<RenderedContext>([]);
    const mailbox = createAgentMailbox();
    const offline = signal(false);
    const lastProcessedMs = signal(0);
    const lastTRInterrupted = signal(false);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    void loadTRs(chatId).then(trs => lastTRInterrupted(wasToolLoopInterrupted(trs)));
    const running = signal(false);
    const failedRc = signal<RenderedContext | null>(null);
    const focusMode = signal(false);
    const scheduler = createSchedulerState();

    // --- Skills state ---
    // Always all skills are available to preserve prefix consistency across epochs.
    const allSkills = chatConfig.skills?.folder
      ? loadSkillsFromFolder(chatConfig.skills.folder, { log })
      : new Map();

    // --- Compaction state as signal ---
    // Initialized from DB on scope creation (cold start). Updated by the
    // compaction effect when it completes. Read by the reply effect to
    // get cursor + summary. No runtime DB queries.
    const compactionMeta = signal<CompactionSessionMeta | null>(
      deps.loadCompaction(chatId),
    );

    // Derived values for convenience
    const cursorMs = computed(() => compactionMeta()?.newCursorMs);
    const summary = computed(() => compactionMeta()?.summary);

    // --- Auto-apply cursor to pipeline when compaction state changes ---
    // When compactionMeta updates (from cold start init or compaction completion),
    // tell the pipeline to re-render RC excluding nodes before the cursor.
    const disposeCursorEffect = effect(() => {
      const cursor = cursorMs();
      if (cursor == null) return;
      const newRC = deps.setCompactCursor(chatId, cursor);
      if (newRC) rc(newRC);
    });

    const { initialDelayMs, typingExtendMs, maxDelayMs } = chatConfig.debounce;

    const wakeMain = () => {
      schedulerController.wake();
    };

    const createSendMessageTurnFlags = (turn: TurnState): SendMessageTurnFlags => ({
      get wasLengthLimited() {
        return turn.flags.sendMessageWasLengthLimited;
      },
      set wasLengthLimited(value: boolean) {
        turn.flags.sendMessageWasLengthLimited = value;
      },
      get inFocusMode() {
        return turn.flags.inFocusMode;
      },
    });

    const toolProviderDeps = (): CapabilityToolProviderDeps => ({
      chatId,
      chatConfig,
      allSkills,
      runtimeConfig: deps.runtimeConfig,
      loadMessageAttachments: deps.loadMessageAttachments,
      downloadFile: deps.downloadFile,
      downloadMessageMedia: deps.downloadMessageMedia,
      sendMessage: deps.sendMessage,
      getPlatformAdapter: deps.getPlatformAdapter,
      sendReaction: deps.sendReaction,
      resolveModel: deps.resolveModel,
      backgroundTask: {
        startTask: deps.backgroundTask.startTask,
        killTask: deps.backgroundTask.killTask,
        readTaskOutput: deps.backgroundTask.readTaskOutput,
      },
      focusMode,
      getActiveTurn: () => chatScopes.get(chatId)?.activeTurn ?? null,
      log,
    });

    const createCapabilityTools = (
      capabilities: TurnState['capabilities'],
      reactionEmojis: string[] = [],
      sendMessageTurnFlags?: SendMessageTurnFlags,
    ): CahciuaTool[] => {
      return createToolsForCapabilities(toolProviderDeps(), capabilities, reactionEmojis, sendMessageTurnFlags);
    };

    let nextTurnId = 1;
    const getScope = (): ChatScope => {
      const current = chatScopes.get(chatId);
      if (!current) throw new Error(`Driver scope missing for chat ${chatId}`);
      return current;
    };

    const subagentManager = createSubagentManager({
      chatId,
      mailbox,
      model: chatConfig.subagents.model,
      maxConcurrent: chatConfig.subagents.maxConcurrent,
      maxSteps: chatConfig.subagents.maxSteps,
      getScope,
      renderSystemPrompt: state => renderSubagentSystemPrompt({
        modelName: chatConfig.subagents.model.model,
        task: state.task,
        context: state.context,
        expectedOutput: state.expectedOutput,
      }),
      createTools: () => createCapabilityTools(createDefaultTurnCapabilities('subagent')),
      persistStep: async (agentId, stepEntries, usage, requestedAtMs) => {
        await deps.persistTurnResponse(chatId, {
          requestedAtMs,
          entries: stepEntries,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          modelName: chatConfig.subagents.model.model,
          agentId,
        });
      },
      wakeMain,
      log,
    });

    const createMainTurn = (
      rcAtStart: RenderedContext,
      abortController: AbortController,
      wasOfflineAtStart: boolean,
    ): TurnState => ({
      id: `main-${Date.now()}-${nextTurnId++}`,
      kind: 'main',
      chatId,
      agentId: 'main',
      scope: getScope(),
      model: chatConfig.primaryModel,
      rcAtStart,
      trs: [],
      entries: [],
      system: '',
      tools: [],
      step: 1,
      maxSteps: MAX_STEPS,
      pendingPrune: false,
      abortController,
      capabilities: createDefaultTurnCapabilities('main'),
      loadedSkills: new Set(),
      reactionEmojis: [],
      flags: {
        wasOfflineAtStart,
        interruptedByInput: false,
        sendMessageWasLengthLimited: false,
        modelStayedSilent: false,
        inFocusMode: false,
      },
    });

    const runMainTurn = async (turn: TurnState, features: DriverFeature[]): Promise<void> => {
      const runner = getOrCreateRunner(turn.model);
      await runTurn(turn, createTurnPhases({
        runner,
        executorChatId: chatId,
        log,
        maxImagesAllowed: turn.model.maxImagesAllowed,
        features,
      }));
    };

    // Called from timer callbacks to start the async LLM work.
    const executeLlmCall = () => {
      const turnStart = schedulerController.beginTurn();
      if (!turnStart) return;
      const { rcAtStart, wasOffline } = turnStart;

      void (async () => {
        try {
          const stepAbortController = new AbortController();
          const turn = createMainTurn(rcAtStart, stepAbortController, wasOffline);
          turn.scope.activeTurn = turn;
          schedulerController.attachAbortController(stepAbortController);
          const features = createMainTurnFeatures({
            chatId,
            getChatName,
            chatConfig,
            log,
            rc,
            offline,
            running,
            lastProcessedMs,
            cursorMs,
            summary,
            allSkills,
            mailbox,
            subagentManager,
            loadTRs,
            loadTurnResponses: deps.loadTurnResponses,
            persistTurnResponse: deps.persistTurnResponse,
            createCapabilityTools,
            createSendMessageTurnFlags,
            lastTRInterrupted,
            schedulerController,
            focusMode,
            refreshAllowedReactionEmojis: deps.refreshAllowedReactionEmojis,
            getAllowedReactionEmojis: deps.getAllowedReactionEmojis,
            getActiveBackgroundTasks: deps.backgroundTask.getActiveTasks,
            nowString: localTimeNow,
          });
          await runMainTurn(turn, features);
        } catch (err) {
          if (err instanceof TurnPreparationSkipped) return;
          // runTurn already called failTurn/cleanupTurn for real failures.
        }
      })();
    };

    const schedulerController = createDriverScheduler({
      chatId,
      rc,
      offline,
      running,
      lastProcessedMs,
      lastTRInterrupted,
      failedRc,
      focusMode,
      scheduler,
      getActiveTurn: () => chatScopes.get(chatId)?.activeTurn ?? null,
    }, {
      initialDelayMs,
      typingExtendMs,
      maxDelayMs,
      startTurn: executeLlmCall,
      onDebounceStateChange: deps.onDebounceStateChange,
      log,
    });

    // --- Independent compaction effect ---
    let compactionTask: Promise<ManualCompactionResult> | undefined;
    let compactionTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCheckedRc: RenderedContext | null = null;

    const compact = (manual: boolean): Promise<ManualCompactionResult> => {
      if (compactionTask) return compactionTask;

      compactionTask = (async (): Promise<ManualCompactionResult> => {
        const cursor = cursorMs();
        const sum = summary();
        const compactEndpoint = chatConfig.compaction.model ?? chatConfig.primaryModel;
        const rcSnapshot = rc();
        const trs = await loadTRs(chatId, cursor);
        const ctx = composeContext(
          rcSnapshot,
          trs,
          chatConfig.compaction.maxContextEstTokens,
          compactEndpoint.model,
        );
        if (!ctx) return { status: 'skipped', reason: 'no_content' };
        if (!manual && ctx.rawEstimatedTokens <= chatConfig.compaction.maxContextEstTokens)
          return { status: 'skipped', reason: 'within_working_window' };

        const oldCursorMs = cursor ?? 0;
        const newCursorMs = findWorkingWindowCursor(
          rcSnapshot,
          trs,
          chatConfig.compaction.workingWindowEstTokens,
        );
        const rcWindow = rcSnapshot.filter(s => s.receivedAtMs >= oldCursorMs && s.receivedAtMs < newCursorMs);
        const trsWindow = trs.filter(t => t.requestedAtMs >= oldCursorMs && t.requestedAtMs < newCursorMs);
        if (newCursorMs <= oldCursorMs || (rcWindow.length === 0 && trsWindow.length === 0))
          return { status: 'skipped', reason: 'within_working_window' };

        log.withFields({
          chatId,
          manual,
          oldCursorMs,
          newCursorMs,
          rawEstimatedTokens: ctx.rawEstimatedTokens,
          triggerAt: chatConfig.compaction.maxContextEstTokens,
          retainBudget: chatConfig.compaction.workingWindowEstTokens,
        }).log('Triggering compaction');

        const newMeta = await runCompaction({
          apiBaseUrl: compactEndpoint.apiBaseUrl,
          apiKey: compactEndpoint.apiKey,
          model: compactEndpoint.model,
          apiFormat: compactEndpoint.apiFormat,
          timeoutSec: compactEndpoint.timeoutSec,
          extraBody: compactEndpoint.extraBody,
          chatId,
          rcWindow,
          trsWindow,
          existingSummary: sum,
          oldCursorMs,
          newCursorMs,
          maxImagesAllowed: compactEndpoint.maxImagesAllowed,
          log,
        });

        deps.persistCompaction(chatId, newMeta);

        log.withFields({
          chatId,
          manual,
          newCursorMs,
          summaryLength: newMeta.summary.length,
        }).log('Compaction complete');

        compactionMeta(newMeta);
        return { status: 'completed', meta: newMeta };
      })().finally(() => {
        compactionTask = undefined;
      });

      return compactionTask!;
    };

    manualCompactionRequests.set(chatId, () => compact(true));

    const disposeCompactionEffect = effect(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return;

      if (compactionTimer) { clearTimeout(compactionTimer); compactionTimer = undefined; }
      if (compactionTask) return;
      if (rcVal === lastCheckedRc) return;

      compactionTimer = setTimeout(() => {
        lastCheckedRc = rc();
        void compact(false).catch(err => {
          log.withError(err).withFields({ chatId }).error('Compaction failed');
        });
      }, 0);
    });

    const cleanup = () => {
      schedulerController.stop();
      if (compactionTimer) clearTimeout(compactionTimer);
      manualCompactionRequests.delete(chatId);
      disposeCursorEffect();
      disposeCompactionEffect();
    };

    const entry: ChatScope = {
      chatId,
      chatConfig,
      rc,
      offline,
      running,
      lastProcessedMs,
      failedRc,
      mailbox,
      subagents: subagentManager,
      allSkills,
      compactionMeta,
      focusMode,
      scheduler,
      activeTurn: null,
      extendDebounce: () => schedulerController.extendDebounce(),
      notifyTyping: () => schedulerController.notifyTyping(),
      cleanup,
    };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const handleTyping = (chatId: string, userId?: string) => {
    const scope = chatScopes.get(chatId);
    if (!scope) return;
    if (userId) {
      const chatConfig = config.resolveChatConfig(chatId);
      const blockedUserIds = chatConfig.blockedUserIds;
      if (blockedUserIds.includes(userId)) return;
      const exemptUsers = chatConfig.debounce?.typingExemptUsers ?? [];
      if (exemptUsers.includes(userId)) return;
    }
    scope.notifyTyping();
  };

  const setOfflineMode = (chatId: string, isOffline: boolean) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).offline(isOffline);
    log.withFields({ chatId, offline: isOffline }).log('Offline mode changed');
  };

  const requestCompaction = (chatId: string): Promise<ManualCompactionResult> => {
    if (!chatIds.has(chatId)) return Promise.resolve({ status: 'skipped', reason: 'no_content' });
    getOrCreateScope(chatId);
    return manualCompactionRequests.get(chatId)!();
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, setOfflineMode, requestCompaction, stop };
};
