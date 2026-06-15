import { resolve } from 'node:path';

import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { callLlm, type ToolSchema } from './call-llm';
import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, latestInterruptingExternalEventMs, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSubagentSystemPrompt, renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { collectRecentSendMessageAssessments, RECENT_SEND_MESSAGE_WINDOW, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness';
import { loadSkillsFromFolder } from './skills';
import { createAgentMailbox } from './subagents/mailbox';
import { createSubagentManager } from './subagents/manager';
import { createBashTool, createAttachmentDownloader, createDownloadFileTool, createKillTaskTool, createLoadSkillTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createSleepTool, createWebFetchTool, createWebSearchTool, createDismissMessageTool, extractLoadedSkillNames } from './tools';
import type { CahciuaTool, SendMessageAttachment } from './tools';
import type { CompactionSessionMeta, DriverConfig, LlmEndpoint, PlatformAdapter, ProbeResponseV2, ProviderFormat, TurnResponseV2 } from './types';
import { createWebFetcher } from './web-fetch';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { RenderedContext } from '../rendering/types';
import { renderImageToTextSystemPrompt } from '../telegram/image-to-text-prompt';
import { callDescriptionLlm } from '../telegram/llm-description';
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
export type { DriverConfig, ProviderFormat } from './types';
export type { TurnResponseV2, ProbeResponseV2 } from './types';

const MAX_STEPS = Infinity;

const toToolSchema = (t: CahciuaTool): ToolSchema => ({
  name: t.function.name,
  parameters: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number, agentId?: string) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number, attachments?: SendMessageAttachment[]) => Promise<{ messageId: number; date: number }>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
  runtimeConfig: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
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
  const getOrCreateRunner = (endpoint: { apiBaseUrl: string; apiKey: string; model: string; apiFormat?: ProviderFormat; timeoutSec?: number; reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh'; forceToolCall?: boolean }) => {
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
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    offline: ReturnType<typeof signal<boolean>>;
    extendDebounce: () => void;
    notifyTyping: () => void;
    cleanup: () => void;
  }>();

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
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let maxDelayTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceWaiting = false;
    let activeRunRc: RenderedContext | null = null;
    let activeRunInterruptCursorMs = 0;
    let activeRunInterruptedByInput = false;
    let startNextDebounceWithExtendDelay = false;
    let replyBatchDeadlineMs: number | null = null;

    const clearDebounceTimers = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
      if (maxDelayTimer) { clearTimeout(maxDelayTimer); maxDelayTimer = undefined; }
    };

    const wakeMain = () => {
      if (running()) return;
      executeLlmCall();
    };

    const hasInterruptingInputDuringActiveRun = (rcVal = rc()) => {
      const interruptAfterMs = Math.max(lastProcessedMs(), activeRunInterruptCursorMs);
      return activeRunRc != null
        && rcVal !== activeRunRc
        && latestInterruptingExternalEventMs(rcVal, interruptAfterMs) != null;
    };

    const ensureReplyBatchDeadline = () => {
      replyBatchDeadlineMs ??= Date.now() + maxDelayMs;
      return replyBatchDeadlineMs;
    };

    const replyBatchRemainingMs = () =>
      Math.max(0, ensureReplyBatchDeadline() - Date.now());

    const isReplyBatchDeadlineExpired = () =>
      replyBatchDeadlineMs != null && Date.now() >= replyBatchDeadlineMs;

    const markActiveRunInterruptedByInput = () => {
      activeRunInterruptedByInput = true;
      startNextDebounceWithExtendDelay = true;
      ensureReplyBatchDeadline();
    };

    const createSharedTools = (includeSendMessage: boolean): CahciuaTool[] => {
      const platform = deps.getPlatformAdapter?.(chatId);
      const tools: CahciuaTool[] = [];
      if (includeSendMessage) {
        tools.push(createSendMessageTool(async (text, replyTo, attachments) => {
          log.withFields({
            chatId,
            text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
            replyTo,
            attachments: attachments?.length ?? 0,
          }).log('send_message tool called');
          if (platform) {
            const result = await platform.sendMessage(chatId, text, { replyTo, attachments });
            return { messageId: result.messageId };
          }
          const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined, attachments);
          return { messageId: String(sent.messageId) };
        }));
        tools.push(createDismissMessageTool());
      }

      const downloadAttachment = createAttachmentDownloader({
        chatId,
        loadMessageAttachments: deps.loadMessageAttachments,
        downloadFile: deps.downloadFile,
        downloadMessageMedia: deps.downloadMessageMedia,
        platformAdapter: platform,
      });

      tools.push(createBashTool(deps.runtimeConfig, {
        startTask: deps.backgroundTask.startTask,
        sessionId: chatId,
        backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
        compactOutput: chatConfig.tools.bash.compactOutput,
        pseudoCommands: {
          chatId,
          currentChannel: chatConfig.platform,
          ...(chatConfig.skills?.folder ? { skillsFolder: resolve(chatConfig.skills.folder) } : {}),
          skills: allSkills,
        },
      }));
      tools.push(createWebSearchTool(chatConfig.tools.webSearch.tavilyKey));
      if (chatConfig.tools.webFetch)
        tools.push(createWebFetchTool(createWebFetcher(chatConfig.tools.webFetch)));
      tools.push(createDownloadFileTool({ downloadAttachment, runtime: deps.runtimeConfig }));

      const readFileCmd = deps.runtimeConfig.readFile;
      const resolveImageToText = chatConfig.imageToText.enabled && chatConfig.imageToText.model
        ? async (buffer: Buffer, detail: 'low' | 'high') => {
          const maxEdge = detail === 'high' ? 1024 : 512;
          const { default: sharp } = await import('sharp');
          const resized = await sharp(buffer)
            .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          const imageUrl = `data:image/png;base64,${resized.toString('base64')}`;
          const system = await renderImageToTextSystemPrompt({ caption: '', detail });
          const model = deps.resolveModel(chatConfig.imageToText.model!);
          const result = await callDescriptionLlm({
            model, system,
            userText: 'Describe this image.',
            images: [{ url: imageUrl }],
            log, label: 'read-image',
          });
          return result.text.trim();
        }
        : undefined;

      tools.push(createReadImageTool({
        downloadAttachment,
        readFile: async path => {
          const { execFile } = await import('node:child_process');
          return await new Promise<Buffer>((resolve, reject) => {
            const child = execFile(
              readFileCmd[0]!,
              [...readFileCmd.slice(1), path],
              { timeout: 60_000, maxBuffer: deps.runtimeConfig.readFileSizeLimit, encoding: 'buffer' as any },
              (error, stdout) => {
                if (error) reject(new Error(`Failed to read file: ${error.message}`));
                else resolve(stdout as unknown as Buffer);
              },
            );
            child.stdin?.end();
          });
        },
        resolveImageToText,
      }));
      tools.push(createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)));
      tools.push(createReadTaskOutputTool((taskId, offset, limit) => deps.backgroundTask.readTaskOutput(taskId, offset, limit)));
      tools.push(createSleepTool());
      return tools;
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
      createTools: () => createSharedTools(false),
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

    // Called from timer callbacks to start the async LLM work.
    const executeLlmCall = () => {
      if (running()) return;
      clearDebounceTimers();
      if (debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
      debounceWaiting = false;

      // Capture offline state: if this call was triggered in offline mode
      // (by an explicit mention/reply), auto-return to online when done.
      const wasOffline = offline();
      const rcAtStart = rc();
      activeRunRc = rcAtStart;
      activeRunInterruptCursorMs = latestInterruptingExternalEventMs(rcAtStart, lastProcessedMs()) ?? lastProcessedMs();
      activeRunInterruptedByInput = false;
      running(true);

      void (async () => {
        try {
          // Read compaction state from signal — no DB query.
          const cursor = cursorMs();
          const sum = summary();

          const trs = await loadTRs(chatId, cursor);
          const ctx = composeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, chatConfig.primaryModel.model, sum);
          if (!ctx) return;

          const stepAbortController = new AbortController();
          abortManager.current = stepAbortController;
          if (hasInterruptingInputDuringActiveRun() && !isReplyBatchDeadlineExpired()) {
            markActiveRunInterruptedByInput();
            abortManager.current = null;
            return;
          }

          log.withFields({
            chatId,
            entries: ctx.entries.length,
            estimatedTokens: ctx.estimatedTokens,
          }).log('Triggering LLM call');

          const sharedTools = createSharedTools(true);
          const subagentTools = chatConfig.subagents.enabled ? subagentManager.mainTools() : [];
          const skillTools: CahciuaTool[] = [];
          if (allSkills.size > 0) {
            const loadedSkills = extractLoadedSkillNames(ctx.entries);
            skillTools.push(createLoadSkillTool(
              () => allSkills,
              name => { loadedSkills.add(name); },
              name => loadedSkills.has(name),
            ));
          }
          const tools: CahciuaTool[] = [...sharedTools, ...subagentTools, ...skillTools];
          // Probe should not see subagent tools — it only needs to decide silence vs activation.
          const probeTools: CahciuaTool[] = [...sharedTools, ...skillTools];

          const system = await renderSystemPrompt({
            currentChannel: chatConfig.platform,
            modelName: chatConfig.primaryModel.model,
            forceToolCall: chatConfig.primaryModel.forceToolCall,
            systemFiles: chatConfig.systemFiles,
            hasLoadSkillTool: allSkills.size > 0,
            hasSubagentTools: chatConfig.subagents.enabled,
            availableSkills: [...allSkills.values()]
              .map(s => ({
                id: s.name,
                ...(s.format === 'custom-v2' && s.title ? { title: s.title } : {}),
                description: s.description,
                usage: s.usage,
              })),
          });

          // --- Compute mention/reply/interrupt state from RC + TRs ---
          const rcVal = rcAtStart;
          const isInterrupted = wasToolLoopInterrupted(trs);
          const lastMentionedAtMs = rcVal.reduce((max, seg) =>
            (seg.mentionsMe || seg.repliesToMe || seg.isRuntimeEvent) ? Math.max(max, seg.receivedAtMs) : max, 0);
          const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
          const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());
          const recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
            collectRecentSendMessageAssessments(await deps.loadTurnResponses(chatId), RECENT_SEND_MESSAGE_WINDOW, chatConfig.humanLikeness),
          );

          const lateBindingParams = {
            timeNow: localTimeNow(),
            forceToolCall: chatConfig.primaryModel.forceToolCall,
            isMentioned, isReplied,
            recentSendMessageHumanLikenessXml,
            isInterrupted,
            activeBackgroundTasks: deps.backgroundTask.getActiveTasks(chatId),
          };

          // --- Probe gate ---
          // Skip probe if: mentioned, replied to, runtime event, or tool loop was interrupted.
          // In those cases go straight to primary model.
          if (chatConfig.probe.enabled && !isInterrupted) {
            const needsProbe = lastMentionedAtMs <= lastProcessedMs();

            if (needsProbe) {
              log.withFields({ chatId, lastMentionedAtMs, lastProcessedMs: lastProcessedMs() }).log('Running probe');

              const probeEntries = [...ctx.entries];
              injectLateBindingPrompt(probeEntries, await renderLateBindingPrompt({
                ...lateBindingParams, isProbeEnabled: true, isProbing: true,
              }));

              const probeRequestedAt = Date.now();
              const probeResult = await callLlm(
                chatConfig.probe.model, probeEntries, system,
                probeTools.map(toToolSchema),
                { log, label: `probe:${chatId}`, maxImagesAllowed: chatConfig.probe.model.maxImagesAllowed },
              );

              const hasToolCalls = probeResult.entries.some(
                e => e.kind === 'message' && e.role === 'assistant'
                  && e.parts.some(
                    p => p.kind === 'toolCall' && p.name !== 'dismiss_message'
                    /* dismiss_message calls are not considered activations */,
                  ),
              );

              const usage = probeResult.usage;

              log.withFields({ chatId, usage, hasToolCalls }).log('Probe result');

              await deps.persistProbeResponse(chatId, {
                requestedAtMs: probeRequestedAt,
                entries: probeResult.entries,
                inputTokens: probeResult.usage.inputTokens,
                outputTokens: probeResult.usage.outputTokens,
                modelName: chatConfig.probe.model.model,
                isActivated: hasToolCalls,
                createdAt: Date.now(),
              });

              lastProcessedMs(probeRequestedAt);

              if (!hasToolCalls) {
                log.withFields({ chatId }).log('Probe: model chose silence');
                return;
              }
              log.withFields({ chatId }).log('Probe: tool calls detected, activating primary model');
            }
          }

          injectLateBindingPrompt(ctx.entries, await renderLateBindingPrompt({
            ...lateBindingParams, isProbeEnabled: chatConfig.probe.enabled, isProbing: false,
          }));

          const runner = getOrCreateRunner(chatConfig.primaryModel);
          await runner.runStepLoop({
            signal: stepAbortController.signal,
            chatId,
            entries: ctx.entries,
            system,
            tools,
            maxSteps: MAX_STEPS,
            maxImagesAllowed: chatConfig.primaryModel.maxImagesAllowed,
            onStepComplete: async (stepEntries, usage, requestedAtMs) => {
              await deps.persistTurnResponse(chatId, {
                requestedAtMs,
                entries: stepEntries,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                modelName: chatConfig.primaryModel.model,
              });
              lastProcessedMs(requestedAtMs);
            },
            checkInterrupt: () => {
              if (rc() === rcAtStart) return false;
              const hasPendingExternalInput = latestExternalEventMs(rc(), lastProcessedMs()) != null;
              if (!hasPendingExternalInput) return false;
              if (latestInterruptingExternalEventMs(rc(), lastProcessedMs()) != null) {
                const hasPendingRuntimeEvent = rc().some(seg =>
                  seg.receivedAtMs > lastProcessedMs() && !seg.isMyself && !!seg.isRuntimeEvent);
                if (isReplyBatchDeadlineExpired()) return hasPendingRuntimeEvent;
                markActiveRunInterruptedByInput();
              }
              return true;
            },
            pullExternalEntries: () => mailbox.flush('main'),
            log,
          });
        } catch (err) {
          // No retry or backoff — a failed call is recorded via failedRc and
          // only re-attempted when new external messages produce a fresh RC.
          log.withError(err).error('LLM call failed');
          failedRc(rcAtStart);
        } finally {
          if (!activeRunInterruptedByInput)
            replyBatchDeadlineMs = null;
          activeRunRc = null;
          activeRunInterruptCursorMs = 0;
          activeRunInterruptedByInput = false;
          running(false);
          if (wasOffline) {
            offline(false);
            log.withFields({ chatId }).log('Offline mode: auto-returning to online after response');
          }
        }
      })();
    };

    let lastTypingAtMs = 0;

    const TYPING_VALIDITY_MS = 6000;

    // Checked at debounce timer expiry: if typing occurred within the validity
    // window, extend instead of firing. maxDelayTimer bypasses this check.
    const debounceTimerCallback = () => {
      if (debounceWaiting && Date.now() - lastTypingAtMs < TYPING_VALIDITY_MS && !isReplyBatchDeadlineExpired()) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, replyBatchRemainingMs()));
        return;
      }
      executeLlmCall();
    };

    // Exposed to handleTyping — extends the debounce window if waiting.
    const extendDebounce = () => {
      if (!debounceWaiting || running()) return;
      const remainingMs = replyBatchRemainingMs();
      if (remainingMs <= 0) {
        executeLlmCall();
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, remainingMs));
    };

    const notifyTyping = () => {
      lastTypingAtMs = Date.now();
      extendDebounce();
    };

    // The effect reads rc() directly (not just needsReply) so that it re-runs
    // when RC changes even if needsReply stays true — this triggers debounce
    // extension on new messages arriving during the wait period.
    const disposeReplyEffect = effect(() => {
      const rcVal = rc();
      const isRunning = running();

      if (isRunning) {
        if (debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        clearDebounceTimers();
        debounceWaiting = false;
        // New chat messages arrived while a call is running — abort the current
        // call. Runtime events wake the next turn but do not interrupt the
        // in-flight model/tool loop.
        if (hasInterruptingInputDuringActiveRun(rcVal) && !isReplyBatchDeadlineExpired()) {
          markActiveRunInterruptedByInput();
          if (abortManager.current) {
            abortManager.current.abort(new Error('New messages arrived, aborting current call'));
            abortManager.current = null;
          }
        }
        return;
      }

      if (!needsReply()) {
        if (debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        clearDebounceTimers();
        debounceWaiting = false;
        startNextDebounceWithExtendDelay = false;
        replyBatchDeadlineMs = null;
        return;
      }

      // needsReply is true and we're not running.
      const hasInterruptingExternalInput = latestInterruptingExternalEventMs(rcVal, lastProcessedMs()) != null;
      if (!hasInterruptingExternalInput) {
        if (debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
        clearDebounceTimers();
        debounceWaiting = false;
        startNextDebounceWithExtendDelay = false;
        replyBatchDeadlineMs = null;
        executeLlmCall();
        return;
      }

      if (!debounceWaiting) {
        // First trigger — start debounce with initialDelayMs + hard cap.
        // If this turn was just interrupted by a new message, treat that
        // message like an in-flight debounce extension.
        const debounceDelayMs = startNextDebounceWithExtendDelay ? typingExtendMs : initialDelayMs;
        startNextDebounceWithExtendDelay = false;
        const remainingMs = replyBatchRemainingMs();
        if (remainingMs <= 0) {
          executeLlmCall();
          return;
        }
        const effectiveDebounceDelayMs = Math.min(debounceDelayMs, remainingMs);
        debounceWaiting = true;
        deps.onDebounceStateChange?.(chatId, true);
        debounceTimer = setTimeout(debounceTimerCallback, effectiveDebounceDelayMs);
        maxDelayTimer = setTimeout(executeLlmCall, remainingMs);
        log.withFields({
          chatId,
          debounceDelayMs: effectiveDebounceDelayMs,
          initialDelayMs,
          typingExtendMs,
          maxDelayMs,
          replyBatchDeadlineMs,
        }).log('Debounce started');
      } else {
        // RC changed while waiting (new message) — extend debounce timer,
        // maxDelayTimer stays unchanged as the hard cap.
        const remainingMs = replyBatchRemainingMs();
        if (remainingMs <= 0) {
          executeLlmCall();
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(debounceTimerCallback, Math.min(typingExtendMs, remainingMs));
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
      if (debounceWaiting) deps.onDebounceStateChange?.(chatId, false);
      clearDebounceTimers();
      if (compactionTimer) clearTimeout(compactionTimer);
      abortManager.current = null;
      disposeCursorEffect();
      disposeReplyEffect();
      disposeCompactionEffect();
    };

    const abortManager = { current: null as AbortController | null };
    const entry = { rc, offline, extendDebounce, notifyTyping, cleanup, abortManager };
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
