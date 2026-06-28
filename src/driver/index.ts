import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, latestInterruptingExternalEventMs, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSubagentSystemPrompt, renderSystemPrompt } from './prompt';
import { createRunner, pruneLengthLimitFailures } from './runner';
import { createDriverScheduler } from './scheduler';
import { collectRecentSendMessageAssessments, RECENT_SEND_MESSAGE_WINDOW, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness';
import { loadSkillsFromFolder } from './skills';
import { createAgentMailbox } from './subagents/mailbox';
import { createSubagentManager } from './subagents/manager';
import { createToolsForCapabilities } from './tool-providers';
import type { CapabilityToolProviderDeps } from './tool-providers';
import { createLoadSkillTool, extractLoadedSkillNames } from './tools';
import type { CahciuaTool, SendMessageAttachment, SendMessageTurnFlags } from './tools';
import { createDefaultTurnCapabilities, createSchedulerState } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';
import type { CompactionSessionMeta, DriverConfig, PlatformAdapter, TurnResponseV2 } from './types';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint, ProviderFormat } from '../llm/types';
import type { RenderedContext } from '../rendering/types';
import type { Attachment } from '../telegram/message/types';
import type { ToolResult } from '../unified-api/types';

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
  refreshAllowedReactionEmojis?: (chatId: string) => Promise<string[]>;
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
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void;
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  // Runner cache: keyed by "apiBaseUrl::model" to reuse runners across chats
  // sharing the same endpoint.
  const runners = new Map<string, ReturnType<typeof createRunner>>();
  const getOrCreateRunner = (endpoint: { apiBaseUrl: string; apiKey: string; model: string; apiFormat?: ProviderFormat; timeoutSec?: number; reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh'; forceToolCall?: boolean | 'api' | 'local' }) => {
    const key = `${endpoint.apiBaseUrl}::${endpoint.model}`;
    let runner = runners.get(key);
    if (!runner) {
      runner = createRunner({
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        apiFormat: endpoint.apiFormat ?? 'openai-chat',
        timeoutSec: endpoint.timeoutSec,
        reasoningEffort: endpoint.reasoningEffort,
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

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    // Resolve per-chat config once per scope
    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const mailbox = createAgentMailbox();
    const offline = signal(false);
    const lastProcessedMs = signal(0);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    const running = signal(false);
    const failedRc = signal<RenderedContext | null>(null);
    const scheduler = createSchedulerState();

    // --- Skills state ---
    // Always all skills are available to preserve prefix consistency across epochs.
    const allSkills = chatConfig.skills?.folder
      ? loadSkillsFromFolder(chatConfig.skills.folder)
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

    // --- Main LLM reply effect with debounce ---
    // When new external messages arrive, start a debounce timer (initialDelayMs).
    // New messages or typing events reset it to typingExtendMs. A hard cap
    // (maxDelayMs) is a batch deadline that survives LLM-call interruptions.
    // Before the deadline, new messages abort the in-flight call and reschedule
    // with typingExtendMs; after it, the current call is allowed to finish.
    const needsReply = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return false;
      if (rcVal === failedRc()) return false;
      if (offline()) {
        // In offline mode, only trigger on explicit @mention or reply-to-bot
        const after = lastProcessedMs();
        return rcVal.some(seg =>
          !seg.isMyself && (!!seg.mentionsMe || !!seg.repliesToMe) && seg.receivedAtMs > after);
      }
      return latestExternalEventMs(rcVal, lastProcessedMs()) != null;
    });

    const { initialDelayMs, typingExtendMs, maxDelayMs } = chatConfig.debounce;
    const schedulerController = createDriverScheduler(scheduler, { maxDelayMs });

    const wakeMain = () => {
      if (running()) return;
      executeLlmCall();
    };

    const hasInterruptingInputDuringActiveRun = (rcVal = rc()) => {
      const interruptAfterMs = Math.max(lastProcessedMs(), scheduler.activeRunInterruptCursorMs);
      return scheduler.activeRunRc != null
        && rcVal !== scheduler.activeRunRc
        && latestInterruptingExternalEventMs(rcVal, interruptAfterMs) != null;
    };

    const replyBatchRemainingMs = () =>
      schedulerController.replyBatchRemainingMs();

    const isReplyBatchDeadlineExpired = () =>
      schedulerController.isReplyBatchDeadlineExpired();

    const markActiveRunInterruptedByInput = () => {
      schedulerController.markInterruptedByInput();
    };

    const createSendMessageTurnFlags = (turn: TurnState): SendMessageTurnFlags => ({
      get wasLengthLimited() {
        return turn.flags.sendMessageWasLengthLimited;
      },
      set wasLengthLimited(value: boolean) {
        turn.flags.sendMessageWasLengthLimited = value;
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
      },
    });

    const prepareMainTurn = async (turn: TurnState): Promise<boolean> => {
      // Read compaction state from signal — no DB query.
      const cursor = cursorMs();
      const sum = summary();

      const trs = await loadTRs(chatId, cursor);
      const ctx = composeContext(turn.rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, turn.model.model, sum);
      if (!ctx) return false;

      turn.trs = trs;
      turn.entries = ctx.entries;
      turn.scope.activeTurn = turn;
      scheduler.abortController = turn.abortController;
      if (hasInterruptingInputDuringActiveRun() && !isReplyBatchDeadlineExpired()) {
        markActiveRunInterruptedByInput();
        turn.flags.interruptedByInput = true;
        scheduler.abortController = null;
        return false;
      }

      log.withFields({
        chatId,
        entries: turn.entries.length,
        estimatedTokens: ctx.estimatedTokens,
      }).log('Triggering LLM call');

      if (chatConfig.platform === 'telegram' && deps.refreshAllowedReactionEmojis) {
        try {
          turn.reactionEmojis = await deps.refreshAllowedReactionEmojis(chatId);
        } catch (err) {
          log.withError(err).withFields({ chatId }).warn('Failed to refresh Telegram reaction emojis');
          turn.reactionEmojis = deps.getAllowedReactionEmojis?.(chatId) ?? [];
        }
      }

      turn.capabilities.canReact = chatConfig.platform === 'telegram' && turn.reactionEmojis.length > 0;
      turn.capabilities.canStartSubagent = chatConfig.subagents.enabled;
      turn.capabilities.canMessageSubagent = chatConfig.subagents.enabled;

      const sharedTools = createCapabilityTools(turn.capabilities, turn.reactionEmojis, createSendMessageTurnFlags(turn));
      const subagentTools = turn.capabilities.canStartSubagent ? subagentManager.mainTools() : [];
      const skillTools: CahciuaTool[] = [];
      if (turn.capabilities.canLoadSkill && allSkills.size > 0) {
        turn.loadedSkills = extractLoadedSkillNames(turn.entries);
        skillTools.push(createLoadSkillTool(
          () => allSkills,
          name => { turn.loadedSkills.add(name); },
          name => turn.loadedSkills.has(name),
        ));
      }
      turn.tools = [...sharedTools, ...subagentTools, ...skillTools];

      turn.system = await renderSystemPrompt({
        currentChannel: chatConfig.platform,
        modelName: chatConfig.primaryModel.model,
        forceToolCall: chatConfig.primaryModel.forceToolCall,
        systemFiles: chatConfig.systemFiles,
        hasLoadSkillTool: allSkills.size > 0,
        hasSubagentTools: chatConfig.subagents.enabled,
        hasReactTool: chatConfig.platform === 'telegram' && turn.reactionEmojis.length > 0,
        availableReactionEmojis: turn.reactionEmojis,
        availableSkills: [...allSkills.values()]
          .map(s => ({
            id: s.name,
            ...(s.format === 'custom-v2' && s.title ? { title: s.title } : {}),
            description: s.description,
            usage: s.usage,
          })),
      });

      const isInterrupted = wasToolLoopInterrupted(turn.trs);
      const isMentioned = turn.rcAtStart.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
      const isReplied = turn.rcAtStart.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());
      const recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
        collectRecentSendMessageAssessments(await deps.loadTurnResponses(chatId), RECENT_SEND_MESSAGE_WINDOW, chatConfig.humanLikeness),
      );

      injectLateBindingPrompt(turn.entries, await renderLateBindingPrompt({
        timeNow: localTimeNow(),
        forceToolCall: chatConfig.primaryModel.forceToolCall,
        isMentioned,
        isReplied,
        recentSendMessageHumanLikenessXml,
        isInterrupted,
        activeBackgroundTasks: deps.backgroundTask.getActiveTasks(chatId),
      }));

      return true;
    };

    const runPreparedMainTurn = async (turn: TurnState): Promise<void> => {
      const runner = getOrCreateRunner(turn.model);
      let working = [...turn.entries];

      for (let step = 1; step <= turn.maxSteps; step++) {
        const externalEntries = mailbox.flush('main');
        if (externalEntries.length > 0)
          working = [...working, ...externalEntries];

        const { stepEntries, usage, requestedAtMs, hasToolCalls } = await runner.runOneStep(working, {
          signal: turn.abortController.signal,
          chatId,
          system: turn.system,
          tools: turn.tools,
          maxImagesAllowed: turn.model.maxImagesAllowed,
          log,
        }, step);

        if (stepEntries.length === 0) {
          turn.flags.modelStayedSilent = true;
          log.withFields({ chatId, step }).log('Model chose to stay silent');
          await deps.persistTurnResponse(chatId, {
            requestedAtMs,
            entries: [],
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            modelName: turn.model.model,
          });
          lastProcessedMs(requestedAtMs);
          break;
        }

        const toolResults = stepEntries.filter((e): e is ToolResult => e.kind === 'toolResult');
        const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp);

        log.withFields({
          chatId, step,
          hasToolCalls, newEntries: stepEntries.length, usage,
        }).log('Step completed');

        const { pruned, pendingPrune } = pruneLengthLimitFailures(stepEntries, turn.pendingPrune);
        turn.pendingPrune = pendingPrune;
        await deps.persistTurnResponse(chatId, {
          requestedAtMs,
          entries: pruned,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          modelName: turn.model.model,
        });
        lastProcessedMs(requestedAtMs);

        if (!hasToolCalls || !anyRequiresFollowUp) {
          if (hasToolCalls && !anyRequiresFollowUp)
            log.withFields({ chatId, step }).log('All tool calls completed without follow-up');
          break;
        }

        if (rc() !== turn.rcAtStart) {
          const hasPendingExternalInput = latestExternalEventMs(rc(), lastProcessedMs()) != null;
          if (hasPendingExternalInput && latestInterruptingExternalEventMs(rc(), lastProcessedMs()) != null) {
            const hasPendingRuntimeEvent = rc().some(seg =>
              seg.receivedAtMs > lastProcessedMs() && !seg.isMyself && !!seg.isRuntimeEvent);
            if (isReplyBatchDeadlineExpired()) {
              if (hasPendingRuntimeEvent) {
                log.withFields({ chatId, step }).log('Turn interrupted by new messages');
                break;
              }
            } else {
              markActiveRunInterruptedByInput();
              turn.flags.interruptedByInput = true;
              log.withFields({ chatId, step }).log('Turn interrupted by new messages');
              break;
            }
          } else if (hasPendingExternalInput) {
            log.withFields({ chatId, step }).log('Turn interrupted by new messages');
            break;
          }
        }

        working = [...working, ...stepEntries];
        turn.entries = working;
        turn.step++;
      }
    };

    // Called from timer callbacks to start the async LLM work.
    const executeLlmCall = () => {
      if (running()) return;
      schedulerController.clearDebounceTimers();
      if (scheduler.debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
      scheduler.debounceWaiting = false;

      // Capture offline state: if this call was triggered in offline mode
      // (by an explicit mention/reply), auto-return to online when done.
      const wasOffline = offline();
      const rcAtStart = rc();
      schedulerController.startActiveRun(
        rcAtStart,
        latestInterruptingExternalEventMs(rcAtStart, lastProcessedMs()) ?? lastProcessedMs(),
      );
      running(true);

      void (async () => {
        let activeTurn: TurnState | null = null;
        try {
          const stepAbortController = new AbortController();
          const turn = createMainTurn(rcAtStart, stepAbortController, wasOffline);
          activeTurn = turn;
          const prepared = await prepareMainTurn(turn);
          if (!prepared) return;
          await runPreparedMainTurn(turn);
        } catch (err) {
          // No retry or backoff — a failed call is recorded via failedRc and
          // only re-attempted when new external messages produce a fresh RC.
          log.withError(err).error('LLM call failed');
          failedRc(rcAtStart);
        } finally {
          schedulerController.onTurnSettled();
          if (activeTurn) activeTurn.scope.activeTurn = null;
          running(false);
          if (wasOffline) {
            offline(false);
            log.withFields({ chatId }).log('Offline mode: auto-returning to online after response');
          }
        }
      })();
    };

    const TYPING_VALIDITY_MS = 6000;

    // Checked at debounce timer expiry: if typing occurred within the validity
    // window, extend instead of firing. maxDelayTimer bypasses this check.
    const debounceTimerCallback = () => {
      if (scheduler.debounceWaiting && Date.now() - scheduler.lastTypingAtMs < TYPING_VALIDITY_MS && !isReplyBatchDeadlineExpired()) {
        if (scheduler.debounceTimer) clearTimeout(scheduler.debounceTimer);
        scheduler.debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, replyBatchRemainingMs()));
        return;
      }
      executeLlmCall();
    };

    // Exposed to handleTyping — extends the debounce window if waiting.
    const extendDebounce = () => {
      if (!scheduler.debounceWaiting || running()) return;
      const remainingMs = replyBatchRemainingMs();
      if (remainingMs <= 0) {
        executeLlmCall();
        return;
      }
      if (scheduler.debounceTimer) clearTimeout(scheduler.debounceTimer);
      scheduler.debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, remainingMs));
    };

    const notifyTyping = () => {
      scheduler.lastTypingAtMs = Date.now();
      extendDebounce();
    };

    // The effect reads rc() directly (not just needsReply) so that it re-runs
    // when RC changes even if needsReply stays true — this triggers debounce
    // extension on new messages arriving during the wait period.
    const disposeReplyEffect = effect(() => {
      const rcVal = rc();
      const isRunning = running();

      if (isRunning) {
        if (scheduler.debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        schedulerController.clearWaitingState();
        // New chat messages arrived while a call is running — abort the current
        // call. Runtime events wake the next turn but do not interrupt the
        // in-flight model/tool loop.
        if (hasInterruptingInputDuringActiveRun(rcVal) && !isReplyBatchDeadlineExpired()) {
          markActiveRunInterruptedByInput();
          if (scheduler.abortController) {
            scheduler.abortController.abort(new Error('New messages arrived, aborting current call'));
            scheduler.abortController = null;
          }
        }
        return;
      }

      if (!needsReply()) {
        if (scheduler.debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        schedulerController.resetIdleBatch();
        return;
      }

      // needsReply is true and we're not running.
      const hasInterruptingExternalInput = latestInterruptingExternalEventMs(rcVal, lastProcessedMs()) != null;
      if (!hasInterruptingExternalInput) {
        if (scheduler.debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        schedulerController.resetIdleBatch();
        executeLlmCall();
        return;
      }

      if (!scheduler.debounceWaiting) {
        // First trigger — start debounce with initialDelayMs + hard cap.
        // If this turn was just interrupted by a new message, treat that
        // message like an in-flight debounce extension.
        const debounceDelayMs = scheduler.startNextDebounceWithExtendDelay ? typingExtendMs : initialDelayMs;
        scheduler.startNextDebounceWithExtendDelay = false;
        const remainingMs = replyBatchRemainingMs();
        if (remainingMs <= 0) {
          executeLlmCall();
          return;
        }
        const effectiveDebounceDelayMs = Math.min(debounceDelayMs, remainingMs);
        scheduler.debounceWaiting = true;
        deps.onDebounceStateChange?.(chatId, true);
        scheduler.debounceTimer = setTimeout(debounceTimerCallback, effectiveDebounceDelayMs);
        scheduler.maxDelayTimer = setTimeout(executeLlmCall, remainingMs);
        log.withFields({
          chatId,
          debounceDelayMs: effectiveDebounceDelayMs,
          initialDelayMs,
          typingExtendMs,
          maxDelayMs,
          replyBatchDeadlineMs: scheduler.replyBatchDeadlineMs,
        }).log('Debounce started');
      } else {
        // RC changed while waiting (new message) — extend debounce timer,
        // maxDelayTimer stays unchanged as the hard cap.
        const remainingMs = replyBatchRemainingMs();
        if (remainingMs <= 0) {
          executeLlmCall();
          return;
        }
        if (scheduler.debounceTimer) clearTimeout(scheduler.debounceTimer);
        scheduler.debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, remainingMs));
      }
    });

    // --- Independent compaction effect ---
    let compactionRunning = false;
    let compactionTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCheckedRc: RenderedContext | null = null;

    const disposeCompactionEffect = effect(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return;

      if (compactionTimer) { clearTimeout(compactionTimer); compactionTimer = undefined; }
      if (compactionRunning) return;
      if (rcVal === lastCheckedRc) return;

      compactionTimer = setTimeout(() => {
        lastCheckedRc = rc();
        compactionRunning = true;

        void (async () => {
          try {
            const cursor = cursorMs();
            const sum = summary();
            const compactEndpoint = chatConfig.compaction.model ?? chatConfig.primaryModel;

            const trs = await loadTRs(chatId, cursor);
            const ctx = composeContext(rc(), trs, chatConfig.compaction.maxContextEstTokens, compactEndpoint.model);
            if (!ctx) return;
            if (ctx.rawEstimatedTokens <= chatConfig.compaction.maxContextEstTokens) return;

            const newCursorMs = findWorkingWindowCursor(rc(), trs, chatConfig.compaction.workingWindowEstTokens);

            log.withFields({
              chatId,
              oldCursorMs: cursor ?? 0,
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
              reasoningEffort: compactEndpoint.reasoningEffort,
              chatId,
              rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
              trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
              existingSummary: sum,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              maxImagesAllowed: compactEndpoint.maxImagesAllowed,
              log,
            });

            deps.persistCompaction(chatId, newMeta);

            log.withFields({
              chatId,
              newCursorMs,
              summaryLength: newMeta.summary.length,
            }).log('Compaction complete');

            compactionMeta(newMeta);
          } catch (err) {
            log.withError(err).error('Compaction failed');
          } finally {
            compactionRunning = false;
          }
        })();
      }, 0);
    });

    const cleanup = () => {
      if (scheduler.debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
      schedulerController.clearDebounceTimers();
      if (compactionTimer) clearTimeout(compactionTimer);
      scheduler.abortController = null;
      disposeCursorEffect();
      disposeReplyEffect();
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
      scheduler,
      activeTurn: null,
      extendDebounce,
      notifyTyping,
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

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, setOfflineMode, stop };
};
