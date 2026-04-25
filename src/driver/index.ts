import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';
import type { Message } from 'xsai';

import { runCompaction } from './compaction';
import { cloneMessagesForSend, composeContext, findWorkingWindowCursor, latestExternalEventMs, prepareChatMessagesForSend, prepareAnthropicMessagesForSend, prepareResponsesInputForSend, wasToolLoopInterrupted } from './context';
import { xsaiToolToAnthropicTool, xsaiToolToResponsesTool } from './convert';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { collectRecentSendMessageAssessments, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness';
import { streamingChat } from './streaming';
import { streamingAnthropic } from './streaming-anthropic';
import { streamingResponses } from './streaming-responses';
import { createBashTool, createAttachmentDownloader, createDismissMessageTool, createDownloadFileTool, createKillTaskTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createWebSearchTool } from './tools';
import type { CahciuaTool, SendMessageAttachment } from './tools';
import type { AnthropicTRDataEntry, CompactionSessionMeta, DriverConfig, LlmEndpoint, ProviderFormat, ResponsesTRDataItem, TRDataEntry, TurnResponse } from './types';
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
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverConfig, ProviderFormat, TurnResponse } from './types';

const MAX_STEPS = Infinity;

// Append late-binding prompt as a separate user message at the end.
// Preserves KV cache for system prompt and prior messages.
const injectLateBindingPrompt = (messages: Message[], prompt: string): void => {
  messages.push({ role: 'user', content: prompt } as Message);
};

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number) => TurnResponse[];
  persistTurnResponse: (chatId: string, tr: TurnResponse) => void;
  persistProbeResponse: (chatId: string, probe: {
    requestedAtMs: number;
    provider: string;
    data: Record<string, any>[];
    inputTokens: number;
    outputTokens: number;
    reasoningSignatureCompat: string;
    isActivated: boolean;
  }) => void;
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
  sendTypingAction?: (chatId: string) => Promise<void>;
  backgroundTask?: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    getActiveTasks: (sessionId: string) => ActiveTaskInfo[];
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
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
        maxTokens: endpoint.maxTokens,
        timeoutSec: endpoint.timeoutSec,
        thinking: endpoint.thinking,
      });
      runners.set(key, runner);
    }
    return runner;
  };

  const loadTRs = (chatId: string, afterMs?: number): TurnResponse[] =>
    deps.loadTurnResponses(chatId, afterMs);

  const getLastProcessedTime = (chatId: string): number => {
    const trs = deps.loadTurnResponses(chatId);
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    onNewMessage: () => void;
    onTyping: () => void;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    // Resolve per-chat config once per scope
    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(getLastProcessedTime(chatId));
    const running = signal(false);
    const failedRc = signal<RenderedContext | null>(null);

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

    // --- Debounce state ---
    // Debounce delays the LLM call after new external messages arrive, allowing
    // messages sent in quick succession (and ongoing typing) to batch naturally.
    // The reactive effect detects "needsReply" transitions; imperative handlers
    // (onNewMessage, onTyping) reset the timer during the debounce window.
    // Only messages from the same sender that triggered the debounce window
    // reset the timer; typing events from anyone extend it.
    const { initialDelayMs, typingExtendMs, maxDelayMs } = chatConfig.debounce;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceActive = false;
    let triggerSenderId: string | undefined;

    const cancelDebounce = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = undefined; }
      debounceActive = false;
      triggerSenderId = undefined;
    };

    // --- LLM reply flow (extracted from timer callback) ---
    const startReplyFlow = () => {
      cancelDebounce();
      if (running()) return;
      const rcAtStart = rc();
      running(true);

      void (async () => {
        try {
          // Read compaction state from signal — no DB query.
          const cursor = cursorMs();
          const sum = summary();

          const trs = loadTRs(chatId, cursor);
          const ctx = composeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, chatConfig.primaryModel.reasoningSignatureCompat, chatConfig.featureFlags, sum);
          if (!ctx) return;

          log.withFields({
            chatId,
            messages: ctx.messages.length,
            estimatedTokens: ctx.estimatedTokens,
          }).log('Triggering LLM call');

          const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
            log.withFields({
              chatId,
              text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
              replyTo,
              attachments: attachments?.length ?? 0,
            }).log('send_message tool called');
            const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined, attachments);
            return { messageId: String(sent.messageId) };
          }, chatConfig.tools.sendMessage.enableAttachments);

          const hasBashTool = chatConfig.tools.bash.enabled;
          const hasWebSearchTool = chatConfig.tools.webSearch.enabled && !!chatConfig.tools.webSearch.tavilyKey;
          const hasDownloadFileTool = chatConfig.tools.downloadFile.enabled && !!deps.runtimeConfig.writeFile;
          const hasReadImageTool = chatConfig.tools.readImage.enabled;
          const hasReadImageFilePathSupport = !!deps.runtimeConfig.readFile;
          const hasAttachmentSupport = chatConfig.tools.sendMessage.enableAttachments;
          const hasBackgroundTasks = hasBashTool && !!deps.backgroundTask;

          const downloadAttachment = createAttachmentDownloader({
            chatId,
            loadMessageAttachments: deps.loadMessageAttachments,
            downloadFile: deps.downloadFile,
            downloadMessageMedia: deps.downloadMessageMedia,
          });

          const tools: CahciuaTool[] = [sendMessageTool, createDismissMessageTool()];
          if (hasBashTool) tools.push(createBashTool(deps.runtimeConfig, deps.backgroundTask ? {
            startTask: deps.backgroundTask.startTask,
            sessionId: chatId,
            backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
          } : undefined));
          if (hasWebSearchTool) tools.push(createWebSearchTool(chatConfig.tools.webSearch.tavilyKey));
          if (hasDownloadFileTool) tools.push(createDownloadFileTool({
            downloadAttachment,
            runtime: deps.runtimeConfig,
          }));
          if (hasReadImageTool) {
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
              readFile: readFileCmd
                ? async path => {
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
                }
                : undefined,
              resolveImageToText,
            }));
          }
          if (hasBackgroundTasks) {
            tools.push(createKillTaskTool(taskId => deps.backgroundTask!.killTask(taskId)));
            tools.push(createReadTaskOutputTool((taskId, offset, limit) => deps.backgroundTask!.readTaskOutput(taskId, offset, limit)));
          }

          const system = await renderSystemPrompt({
            currentChannel: 'telegram',
            modelName: chatConfig.primaryModel.model,
            systemFiles: chatConfig.systemFiles,
            hasBashTool,
            hasWebSearchTool,
            hasDownloadFileTool,
            hasReadImageTool,
            hasReadImageFilePathSupport,
            hasAttachmentSupport,
            hasBackgroundTasks,
          });

          // --- Compute mention/reply/interrupt state from RC + TRs ---
          const rcVal = rcAtStart;
          const isInterrupted = wasToolLoopInterrupted(trs);
          const lastMentionedAtMs = rcVal.reduce((max, seg) =>
            (seg.mentionsMe || seg.repliesToMe || seg.isRuntimeEvent) ? Math.max(max, seg.receivedAtMs) : max, 0);
          const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
          const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());
          const recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
            collectRecentSendMessageAssessments(deps.loadTurnResponses(chatId), undefined, chatConfig.humanLikeness),
          );

          // --- Probe gate ---
          // Skip probe if: mentioned, replied to, runtime event, or tool loop was interrupted.
          // In those cases go straight to primary model.
          if (chatConfig.probe.enabled && !isInterrupted) {
            const needsProbe = lastMentionedAtMs <= lastProcessedMs();

            if (needsProbe) {
              log.withFields({ chatId, lastMentionedAtMs, lastProcessedMs: lastProcessedMs() }).log('Running probe');

              const probeMessages = cloneMessagesForSend(ctx.messages);

              const probeLateBinding = await renderLateBindingPrompt({
                timeNow: localTimeNow(),
                isProbeEnabled: true, isProbing: true, isMentioned, isReplied,
                recentSendMessageHumanLikenessXml,
                activeBackgroundTasks: deps.backgroundTask?.getActiveTasks(chatId),
              });
              injectLateBindingPrompt(probeMessages, probeLateBinding);

              const probeRequestedAt = Date.now();
              const probeApiFormat: ProviderFormat = chatConfig.probe.model.apiFormat ?? 'openai-chat';

              // Unified probe call — extract { hasToolCalls, data, inputTokens, outputTokens }
              let probe: { hasToolCalls: boolean; data: Record<string, any>[]; inputTokens: number; outputTokens: number };
              if (probeApiFormat === 'responses') {
                const r = await streamingResponses({
                  baseURL: chatConfig.probe.model.apiBaseUrl, apiKey: chatConfig.probe.model.apiKey,
                  model: chatConfig.probe.model.model,
                  input: prepareResponsesInputForSend(probeMessages, chatConfig.probe.model.maxImagesAllowed),
                  instructions: system, tools: tools.map(xsaiToolToResponsesTool),
                  thinking: chatConfig.probe.model.thinking,
                  log, label: `probe:${chatId}`, timeoutSec: chatConfig.probe.model.timeoutSec,
                });
                probe = {
                  hasToolCalls: r.output.some(item => item.type === 'function_call'),
                  data: r.output as Record<string, any>[],
                  inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens,
                };
              } else if (probeApiFormat === 'anthropic') {
                const r = await streamingAnthropic({
                  baseURL: chatConfig.probe.model.apiBaseUrl, apiKey: chatConfig.probe.model.apiKey,
                  model: chatConfig.probe.model.model,
                  messages: prepareAnthropicMessagesForSend(probeMessages, chatConfig.probe.model.maxImagesAllowed),
                  system, tools: tools.map(xsaiToolToAnthropicTool),
                  maxTokens: chatConfig.probe.model.maxTokens,
                  thinking: chatConfig.probe.model.thinking,
                  log, label: `probe:${chatId}`, timeoutSec: chatConfig.probe.model.timeoutSec,
                });
                probe = {
                  hasToolCalls: r.content.some(b => b.type === 'tool_use'),
                  data: [{ role: 'assistant', content: r.content }] as Record<string, any>[],
                  inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
                };
              } else {
                const r = await streamingChat({
                  baseURL: chatConfig.probe.model.apiBaseUrl, apiKey: chatConfig.probe.model.apiKey,
                  model: chatConfig.probe.model.model,
                  messages: prepareChatMessagesForSend(probeMessages, chatConfig.probe.model.maxImagesAllowed),
                  system, thinking: chatConfig.probe.model.thinking,
                  tools, log, label: `probe:${chatId}`, timeoutSec: chatConfig.probe.model.timeoutSec,
                });
                const msg = r.choices[0]?.message;
                probe = {
                  hasToolCalls: (msg?.tool_calls?.length ?? 0) > 0,
                  data: msg ? [msg] as Record<string, any>[] : [],
                  inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens,
                };
              }

              log.withFields({ chatId, hasToolCalls: probe.hasToolCalls }).log('Probe result');

              deps.persistProbeResponse(chatId, {
                requestedAtMs: probeRequestedAt, provider: probeApiFormat,
                data: probe.data, inputTokens: probe.inputTokens, outputTokens: probe.outputTokens,
                reasoningSignatureCompat: chatConfig.probe.model.reasoningSignatureCompat ?? '',
                isActivated: probe.hasToolCalls,
              });

              lastProcessedMs(probeRequestedAt);

              if (!probe.hasToolCalls) {
                log.withFields({ chatId }).log('Probe: model chose silence');
                return;
              }
              log.withFields({ chatId }).log('Probe: tool calls detected, activating primary model');
            }
          }

          const primaryLateBinding = await renderLateBindingPrompt({
            timeNow: localTimeNow(),
            isProbeEnabled: chatConfig.probe.enabled, isProbing: false, isMentioned, isReplied,
            recentSendMessageHumanLikenessXml,
            isInterrupted,
            activeBackgroundTasks: deps.backgroundTask?.getActiveTasks(chatId),
          });
          injectLateBindingPrompt(ctx.messages, primaryLateBinding);

          const runner = getOrCreateRunner(chatConfig.primaryModel);

          // Send typing action for the duration of the primary step loop.
          let typingInterval: ReturnType<typeof setInterval> | undefined;
          if (deps.sendTypingAction && chatConfig.featureFlags.sendTypingAction) {
            void deps.sendTypingAction(chatId).catch(() => {});
            typingInterval = setInterval(() => {
              void deps.sendTypingAction!(chatId).catch(() => {});
            }, 5000);
          }

          try {
            await runner.runStepLoop({
              chatId,
              messages: ctx.messages,
              system,
              tools,
              maxSteps: MAX_STEPS,
              maxImagesAllowed: chatConfig.primaryModel.maxImagesAllowed,
              onStepComplete: (stepData, usage, requestedAtMs) => {
                if (chatConfig.primaryApiFormat === 'responses') {
                  deps.persistTurnResponse(chatId, {
                    requestedAtMs,
                    provider: 'responses',
                    data: stepData as ResponsesTRDataItem[],
                    inputTokens: usage.prompt_tokens,
                    outputTokens: usage.completion_tokens,
                    reasoningSignatureCompat: chatConfig.primaryModel.reasoningSignatureCompat ?? '',
                  });
                } else if (chatConfig.primaryApiFormat === 'anthropic') {
                  deps.persistTurnResponse(chatId, {
                    requestedAtMs,
                    provider: 'anthropic',
                    data: stepData as AnthropicTRDataEntry[],
                    inputTokens: usage.prompt_tokens,
                    outputTokens: usage.completion_tokens,
                    reasoningSignatureCompat: chatConfig.primaryModel.reasoningSignatureCompat ?? '',
                  });
                } else {
                  deps.persistTurnResponse(chatId, {
                    requestedAtMs,
                    provider: 'openai-chat',
                    data: stepData as TRDataEntry[],
                    inputTokens: usage.prompt_tokens,
                    outputTokens: usage.completion_tokens,
                    reasoningSignatureCompat: chatConfig.primaryModel.reasoningSignatureCompat ?? '',
                  });
                }
                lastProcessedMs(requestedAtMs);
              },
              checkInterrupt: () => {
                if (rc() === rcAtStart) return false;
                return latestExternalEventMs(rc(), lastProcessedMs()) != null;
              },
              log,
            });
          } finally {
            if (typingInterval) { clearInterval(typingInterval); typingInterval = undefined; }
          }
        } catch (err) {
          // No retry or backoff — a failed call is recorded via failedRc and
          // only re-attempted when new external messages produce a fresh RC.
          log.withError(err).error('LLM call failed');
          failedRc(rcAtStart);
        } finally {
          running(false);
        }
      })();
    };

    const scheduleDebounce = (delayMs: number, senderId?: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        startReplyFlow();
      }, delayMs);

      if (!debounceActive) {
        debounceActive = true;
        triggerSenderId = senderId;
        hardCapTimer = setTimeout(() => {
          hardCapTimer = undefined;
          startReplyFlow();
        }, maxDelayMs);
        log.withFields({ chatId, delayMs, maxDelayMs, triggerSenderId }).log('Debounce started');
      }
    };

    // --- Main LLM reply effect ---
    // Detects when new external messages require a response and initiates the
    // debounce window. During debounce, imperative handlers (onNewMessage,
    // onTyping) reset the timer. When the timer fires, startReplyFlow runs.
    // The `running` flag prevents concurrent LLM calls; messages arriving
    // during a call accumulate and get picked up on the next debounce cycle.
    const needsReply = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return false;
      if (rcVal === failedRc()) return false;
      return latestExternalEventMs(rcVal, lastProcessedMs()) != null;
    });

    const disposeReplyEffect = effect(() => {
      const isRunning = running();
      if (isRunning) return;

      if (!needsReply()) {
        cancelDebounce();
        return;
      }

      // needsReply transitioned to true — start debounce if not already waiting.
      if (!debounceActive) {
        scheduleDebounce(initialDelayMs);
      }
    });

    // Called by handleEvent when a new message arrives.
    // Starts debounce if not active (with sender tracking), or resets timer
    // if the same sender sends again during the window.
    const onNewMessage = (senderId?: string) => {
      if (running()) return;
      if (!senderId) return;
      if (!debounceActive) {
        // First message — start debounce with sender tracking.
        // The effect would also start it, but without senderId context.
        // Starting here ensures triggerSenderId is captured immediately.
        scheduleDebounce(initialDelayMs, senderId);
      } else if (senderId === triggerSenderId) {
        scheduleDebounce(initialDelayMs, senderId);
      }
    };

    // Called by handleTyping — extends debounce with typing delay regardless of sender
    const onTyping = () => {
      if (running() || !debounceActive) return;
      scheduleDebounce(typingExtendMs);
    };

    // --- Independent compaction effect ---
    let compactionRunning = false;
    let compactionTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCheckedRc: RenderedContext | null = null;

    const disposeCompactionEffect = effect(() => {
      if (!chatConfig.compaction.enabled) return;
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

            const trs = loadTRs(chatId, cursor);
            // Estimate tokens WITHOUT summary — summary should not count toward
            // the working window budget, otherwise it grows until it fills the
            // budget and compaction degrades into a sliding window.
            const ctx = composeContext(rc(), trs, chatConfig.compaction.maxContextEstTokens, compactEndpoint.reasoningSignatureCompat, chatConfig.featureFlags);
            if (!ctx) return;
            // Trigger at maxContextEstTokens (high water mark), compact down to
            // workingWindowEstTokens (low water mark). This gives a wide gap
            // before the next compaction fires.
            if (ctx.rawEstimatedTokens <= chatConfig.compaction.maxContextEstTokens) return;

            const newCursorMs = findWorkingWindowCursor(rc(), trs, chatConfig.compaction.workingWindowEstTokens);

            log.withFields({
              chatId,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              rawEstimatedTokens: ctx.rawEstimatedTokens,
              triggerAt: chatConfig.compaction.maxContextEstTokens,
              retainBudget: chatConfig.compaction.workingWindowEstTokens,
              dryRun: !!chatConfig.compaction.dryRun,
            }).log('Triggering compaction');

            const newMeta = await runCompaction({
              apiBaseUrl: compactEndpoint.apiBaseUrl,
              apiKey: compactEndpoint.apiKey,
              model: compactEndpoint.model,
              apiFormat: compactEndpoint.apiFormat,
              maxTokens: compactEndpoint.maxTokens,
              timeoutSec: compactEndpoint.timeoutSec,
              thinking: compactEndpoint.thinking,
              chatId,
              rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
              trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
              existingSummary: sum,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              reasoningSignatureCompat: compactEndpoint.reasoningSignatureCompat,
              featureFlags: chatConfig.featureFlags,
              maxImagesAllowed: compactEndpoint.maxImagesAllowed,
              log,
            });

            if (chatConfig.compaction.dryRun) {
              log.withFields({
                chatId,
                newCursorMs,
                summaryLength: newMeta.summary.length,
              }).log(`Compaction dry-run complete. Summary:\n${newMeta.summary}`);
            } else {
              // Persist to dedicated compactions table
              deps.persistCompaction(chatId, newMeta);

              log.withFields({
                chatId,
                newCursorMs,
                summaryLength: newMeta.summary.length,
              }).log('Compaction complete');

              // Update signal — cursor effect auto-applies to pipeline + rc
              compactionMeta(newMeta);
            }
          } catch (err) {
            log.withError(err).error('Compaction failed');
          } finally {
            compactionRunning = false;
          }
        })();
      }, 0);
    });

    const cleanup = () => {
      cancelDebounce();
      if (compactionTimer) clearTimeout(compactionTimer);
      disposeCursorEffect();
      disposeReplyEffect();
      disposeCompactionEffect();
    };

    const entry = { rc, onNewMessage, onTyping, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext, senderId?: string) => {
    if (!chatIds.has(chatId)) return;
    const scope = getOrCreateScope(chatId);
    scope.rc(newRC);
    scope.onNewMessage(senderId);
  };

  const handleTyping = (chatId: string) => {
    if (!chatIds.has(chatId)) return;
    log.withFields({ chatId }).log('Typing event received');
    const scope = chatScopes.get(chatId);
    if (scope) scope.onTyping();
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, stop };
};
