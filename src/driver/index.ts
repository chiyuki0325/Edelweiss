import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, wasToolLoopInterrupted } from './context';
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
import { TurnPreparationSkipped } from './turn-features';
import type { DriverFeature } from './turn-features';
import { createTurnPhases, runTurn } from './turn-phases';
import { createDefaultTurnCapabilities, createSchedulerState } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';
import type { CompactionSessionMeta, DriverConfig, PlatformAdapter, TurnResponseV2 } from './types';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint, ProviderFormat } from '../llm/types';
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

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
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
      },
    });

    const createMainTurnFeatures = (): DriverFeature[] => {
      let contextEstimatedTokens = 0;
      let recentSendMessageHumanLikenessXml = '';

      const contextFeature: DriverFeature = {
        name: 'context',
        prepareContext: async turn => {
          const cursor = cursorMs();
          const sum = summary();
          const trs = await loadTRs(chatId, cursor);
          const ctx = composeContext(turn.rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, turn.model.model, sum);
          if (!ctx) throw new TurnPreparationSkipped('No context entries to send');
          turn.trs = trs;
          turn.entries = ctx.entries;
          contextEstimatedTokens = ctx.estimatedTokens;
        },
      };

      const interruptionFeature: DriverFeature = {
        name: 'interruption',
        shouldContinue: (turn, step) => {
          if (!step.hasToolCalls || !step.anyRequiresFollowUp) return undefined;
          if (rc() === turn.rcAtStart) return undefined;

          const hasPendingRuntimeEvent = rc().some(seg =>
            seg.receivedAtMs > lastProcessedMs() && !seg.isMyself && !!seg.isRuntimeEvent);
          if (!hasPendingRuntimeEvent) return undefined;

          log.withFields({ chatId, step: turn.step }).log('Turn stopped at step boundary for runtime event');
          return false;
        },
      };

      const reactionFeature: DriverFeature = {
        name: 'reaction',
        prepareCapabilities: async (turn, signal) => {
          if (chatConfig.platform !== 'telegram' || !deps.refreshAllowedReactionEmojis) return;
          try {
            turn.reactionEmojis = await abortable(deps.refreshAllowedReactionEmojis(chatId, signal), signal);
          } catch (err) {
            if (signal.aborted) throw err;
            log.withError(err).withFields({ chatId }).warn('Failed to refresh Telegram reaction emojis');
            turn.reactionEmojis = deps.getAllowedReactionEmojis?.(chatId) ?? [];
          }
        },
      };

      const capabilityFeature: DriverFeature = {
        name: 'capability',
        prepareCapabilities: turn => {
          turn.capabilities.canReact = chatConfig.platform === 'telegram' && turn.reactionEmojis.length > 0;
          turn.capabilities.canStartSubagent = chatConfig.subagents.enabled;
          turn.capabilities.canMessageSubagent = chatConfig.subagents.enabled;
        },
      };

      const skillFeature: DriverFeature = {
        name: 'skill',
        prepareTools: turn => {
          if (!turn.capabilities.canLoadSkill || allSkills.size === 0) return;
          turn.loadedSkills = extractLoadedSkillNames(turn.entries);
          turn.tools.push(createLoadSkillTool(
            () => allSkills,
            name => { turn.loadedSkills.add(name); },
            name => turn.loadedSkills.has(name),
          ));
        },
      };

      const toolFeature: DriverFeature = {
        name: 'tools',
        prepareTools: turn => {
          const sharedTools = createCapabilityTools(turn.capabilities, turn.reactionEmojis, createSendMessageTurnFlags(turn));
          const subagentTools = turn.capabilities.canStartSubagent ? subagentManager.mainTools() : [];
          turn.tools = [...sharedTools, ...subagentTools];
        },
      };

      const humanLikenessFeature: DriverFeature = {
        name: 'human-likeness',
        preparePrompt: async () => {
          recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
            collectRecentSendMessageAssessments(await deps.loadTurnResponses(chatId), RECENT_SEND_MESSAGE_WINDOW, chatConfig.humanLikeness),
          );
        },
      };

      const promptFeature: DriverFeature = {
        name: 'prompt',
        preparePrompt: async turn => {
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

          injectLateBindingPrompt(turn.entries, await renderLateBindingPrompt({
            timeNow: localTimeNow(),
            forceToolCall: chatConfig.primaryModel.forceToolCall,
            isMentioned,
            isReplied,
            recentSendMessageHumanLikenessXml,
            isInterrupted,
            activeBackgroundTasks: deps.backgroundTask.getActiveTasks(chatId),
          }));
        },
      };

      const mailboxFeature: DriverFeature = {
        name: 'mailbox',
        beforeStep: turn => {
          const externalEntries = mailbox.flush('main');
          if (externalEntries.length > 0)
            turn.entries = [...turn.entries, ...externalEntries];
        },
      };

      const sendMessageFeature: DriverFeature = {
        name: 'send-message',
        transformStepEntries: (turn, entries) => {
          const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, turn.pendingPrune);
          turn.pendingPrune = pendingPrune;
          return pruned;
        },
      };

      const persistenceFeature: DriverFeature = {
        name: 'persistence',
        persistStep: async (turn, step) => {
          await deps.persistTurnResponse(chatId, {
            requestedAtMs: step.requestedAtMs,
            entries: step.persistedEntries,
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            modelName: turn.model.model,
          });
          lastProcessedMs(step.requestedAtMs);
        },
      };

      const failureFeature: DriverFeature = {
        name: 'failure',
        failTurn: (turn, error) => {
          log.withError(error).error('LLM call failed');
          schedulerController.markFailed(turn.rcAtStart);
        },
      };

      const cleanupFeature: DriverFeature = {
        name: 'cleanup',
        cleanupTurn: turn => {
          schedulerController.onTurnSettled();
          schedulerController.clearAbortController(turn.abortController);
          turn.scope.activeTurn = null;
          running(false);
          if (turn.flags.wasOfflineAtStart) {
            offline(false);
            log.withFields({ chatId }).log('Offline mode: auto-returning to online after response');
          }
        },
      };

      const loggingFeature: DriverFeature = {
        name: 'logging',
        preparePrompt: turn => {
          log.withFields({
            chatId,
            entries: turn.entries.length,
            estimatedTokens: contextEstimatedTokens,
          }).log('Triggering LLM call');
        },
      };

      return [
        contextFeature,
        interruptionFeature,
        reactionFeature,
        capabilityFeature,
        toolFeature,
        skillFeature,
        humanLikenessFeature,
        promptFeature,
        loggingFeature,
        mailboxFeature,
        sendMessageFeature,
        persistenceFeature,
        failureFeature,
        cleanupFeature,
      ];
    };

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
          const features = createMainTurnFeatures();
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
      failedRc,
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
      schedulerController.stop();
      if (compactionTimer) clearTimeout(compactionTimer);
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

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, setOfflineMode, stop };
};
