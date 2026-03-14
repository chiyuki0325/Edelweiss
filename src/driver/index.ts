import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { composeContext, latestExternalEventMs } from './context';
import { renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { createSendMessageTool } from './tools';
import type { DriverConfig, TurnResponse } from './types';
import type { DB } from '../db/client';
import { loadTurnResponses, persistTurnResponse } from '../db/persistence';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderSystemPrompt } from './prompt';
export type { DriverConfig, TurnResponse } from './types';

const DEBOUNCE_MS = 2000;
const MAX_STEPS = 5;

export const createDriver = (config: DriverConfig, deps: {
  db: DB;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number) => Promise<{ messageId: number; date: number }>;
  logger: Logger;
}) => {
  const { db, logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  const runner = createRunner({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const loadTRs = (chatId: string): TurnResponse[] => {
    const rows = loadTurnResponses(db, chatId);
    return rows.map(r => ({
      requestedAtMs: r.requestedAt,
      provider: r.provider,
      data: r.data,
      sessionMeta: r.sessionMeta,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningSignatureCompat: r.reasoningSignatureCompat ?? '',
    }));
  };

  const getLastTrTime = (chatId: string): number => {
    const trs = loadTurnResponses(db, chatId);
    if (trs.length === 0) return 0;
    return trs[trs.length - 1]!.requestedAt;
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const rc = signal<RenderedContext>([]);
    const lastTrTimeMs = signal(getLastTrTime(chatId));
    const running = signal(false);
    // Failure latch: blocks retrigger on the same RC that caused a failure.
    // Cleared automatically when rc changes (new event arrives).
    const failedRc = signal<RenderedContext | null>(null);
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Pure derived deadline: latest external event timestamp + debounce window.
    // Event-time based — on restart, old events yield a past deadline (fire
    // immediately), recent events yield a future deadline (wait remaining).
    const deadline = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return null;
      if (rcVal === failedRc()) return null;
      const latestMs = latestExternalEventMs(rcVal, lastTrTimeMs());
      if (latestMs == null) return null;
      return latestMs + DEBOUNCE_MS;
    });

    const disposeEffect = effect(() => {
      const isRunning = running();
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (isRunning) return;

      const d = deadline();
      if (d == null) return;

      const remaining = Math.max(0, d - Date.now());
      timer = setTimeout(() => {
        // Heavy work deferred to after debounce expires
        const trs = loadTRs(chatId);
        const ctx = composeContext(rc(), trs, config.maxContextTokens, config.reasoningSignatureCompat);
        if (!ctx) return;

        const rcAtStart = rc();
        running(true);

        log.withFields({
          chatId,
          messages: ctx.messages.length,
          estimatedTokens: ctx.estimatedTokens,
        }).log('Triggering LLM call');

        const sendMessageTool = createSendMessageTool(async (text, replyTo) => {
          log.withFields({
            chatId,
            text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
            replyTo,
          }).log('send_message tool called');
          await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined);
        });

        void (async () => {
          try {
            const system = await renderSystemPrompt({
              currentChannel: 'telegram',
              timeNow: new Date().toISOString(),
            });

            await runner.runStepLoop({
              chatId,
              messages: ctx.messages,
              system,
              tools: [sendMessageTool],
              maxSteps: MAX_STEPS,
              onStepComplete: (stepData, usage, requestedAtMs) => {
                persistTurnResponse(db, chatId, {
                  requestedAtMs,
                  provider: 'openai-chat',
                  data: stepData,
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  reasoningSignatureCompat: config.reasoningSignatureCompat ?? '',
                });
                lastTrTimeMs(requestedAtMs);
              },
              checkInterrupt: () => {
                if (rc() === rcAtStart) return false;
                // Only interrupt for new external messages, not bot's own
                // messages flowing back via userbot. This improves on the old
                // behavior where any event would kill the step loop.
                //
                // TODO: Bot's own messages enter RC via userbot, duplicating
                // content already present in tool call results within TRs.
                // The merge produces redundant segments. Needs a dedup design
                // — either filter bot segments from RC when TRs cover the
                // same time range, or mark them so merge can skip them.
                return latestExternalEventMs(rc(), lastTrTimeMs()) != null;
              },
              log,
            });
          } catch (err) {
            log.withError(err).error('LLM call failed');
            failedRc(rcAtStart);
          } finally {
            running(false);
          }
        })();
      }, remaining);
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      disposeEffect();
    };

    const entry = { rc, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, stop };
};
