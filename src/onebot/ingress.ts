import type { Logger } from '@guiiai/logg';

import { adaptOneBotMessage, adaptOneBotNotice, oneBotMessageChatId, type OneBotIngressMeta } from './adaptation';
import { resolveOneBotImageAltText } from './image-to-text';
import type { OneBotApiClient } from './server';
import type { OneBotMessageEvent, OneBotNoticeEvent } from './types';
import type { CanonicalBlockedMessageEvent, CanonicalIMEvent, CanonicalMessageEvent } from '../adaption-types';
import type { ManualCompactionResult } from '../driver/types';
import type { MessageDedup } from '../ingress/message-dedup';
import { createSessionIngressQueue } from '../ingress/session-ingress-queue';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import { contentToPlainText } from '../telegram/adaption';

const DEFAULT_TRANSFORM_BUDGET_MS = 90_000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;

const sleep = async (ms: number) => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

export interface AttemptWithBudgetOptions {
  budgetMs: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: unknown, attempt: number, retryInMs: number) => void;
  onGiveUp?: (err: unknown, attempts: number) => void;
}

// Terminable (but never fail-open) retry: re-runs `fn` with exponential backoff
// until it succeeds or the next backoff would exceed the wall-clock budget. The
// first attempt always runs. Returns true on success, false when the budget is
// exhausted — the caller then drops the event rather than admitting degraded data.
//
// This is the OneBot counterpart to Telegram's infinite ingress retry: Telegram
// fileIds stay valid forever, so retrying forever is safe; QQ media URLs / file
// references expire, so unbounded retry could wedge a chat permanently. Bounding
// the budget keeps the commit cursor advancing while still recovering from
// transient failures.
export const attemptWithBudget = async (
  fn: () => Promise<void>,
  opts: AttemptWithBudgetOptions,
): Promise<boolean> => {
  const baseDelay = opts.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const maxDelay = opts.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const deadline = Date.now() + opts.budgetMs;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      await fn();
      return true;
    } catch (err) {
      const delayMs = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      if (Date.now() + delayMs >= deadline) {
        opts.onGiveUp?.(err, attempt);
        return false;
      }
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
};

interface OneBotIngressItem {
  chatId: string;
  raw: OneBotMessageEvent | OneBotNoticeEvent;
  meta: OneBotIngressMeta;
  event?: CanonicalIMEvent;
  dropped?: boolean;
}

export interface OneBotIngressDeps {
  logger: Logger;
  getApi: () => OneBotApiClient | null;
  isWhitelisted: (chatId: string) => boolean;
  isBlocked: (chatId: string, senderId: string | undefined) => boolean;
  toBlockedMessageEvent: (event: CanonicalMessageEvent) => CanonicalBlockedMessageEvent;
  imageToTextChatIds: ReadonlySet<string>;
  imageToTextResolver: ImageToTextResolver;
  animationToTextResolver: AnimationToTextResolver;
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
  persistEvent: (event: CanonicalIMEvent) => void;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext;
  onDriverEvent: (chatId: string, rc: RenderedContext) => void;
  setOfflineMode: (chatId: string, offline: boolean) => void;
  requestCompaction: (chatId: string) => Promise<ManualCompactionResult>;
  sendPlatformMessage: (chatId: string, text: string) => Promise<void>;
  transformBudgetMs?: number;
  // Shared with the cold-start history pull so a message arriving in the overlap
  // window (live WS already open while get_group_msg_history is still running) is
  // only admitted once. Whichever path reserves (chatId, messageId) first wins.
  dedup: MessageDedup;
}

export interface OneBotIngress {
  enqueue(raw: OneBotMessageEvent | OneBotNoticeEvent, meta: OneBotIngressMeta): void;
}

export const createOneBotIngress = (deps: OneBotIngressDeps): OneBotIngress => {
  const log = deps.logger.withContext('onebot:ingress');
  const budgetMs = deps.transformBudgetMs ?? DEFAULT_TRANSFORM_BUDGET_MS;

  const resolveAltText = async (event: CanonicalMessageEvent): Promise<void> => {
    const api = deps.getApi();
    if (!api) throw new Error('OneBot API client unavailable');
    if (!deps.imageToTextChatIds.has(event.chatId) || event.attachments.length === 0) return;
    const caption = contentToPlainText(event.content);
    const compression = deps.getImageToTextCompression(event.chatId);
    await Promise.all(event.attachments.map(att =>
      resolveOneBotImageAltText(att, caption, api, deps.imageToTextResolver, deps.animationToTextResolver, compression)));
  };

  const transformMessage = async (item: OneBotIngressItem): Promise<void> => {
    const ok = await attemptWithBudget(async () => {
      const api = deps.getApi();
      if (!api) throw new Error('OneBot API client unavailable');
      const event = await adaptOneBotMessage(api, item.raw as OneBotMessageEvent, item.meta);
      // Skip alt-text downloads for blocked users — the message is redacted at
      // commit, so resolving descriptions for it would be wasted (and would pull
      // media we are about to discard).
      if (!deps.isBlocked(event.chatId, event.sender?.id)) await resolveAltText(event);
      item.event = event;
    }, {
      budgetMs,
      onRetry: (err, attempt, retryInMs) =>
        log.withError(err).withFields({ chatId: item.chatId, attempt, retryInMs })
          .warn('OneBot ingress transform failed; retrying within budget'),
      onGiveUp: (err, attempts) =>
        log.withError(err).withFields({ chatId: item.chatId, attempts })
          .error('OneBot ingress transform budget exhausted; dropping event to preserve consistency'),
    });
    if (!ok) item.dropped = true;
  };

  const queue = createSessionIngressQueue<OneBotIngressItem>({
    logger: deps.logger,
    logContext: 'onebot:ingress-queue',
    transform: async item => {
      // Notice events are adapted synchronously at enqueue time (no network),
      // so their transform is a no-op.
      if (item.raw.post_type === 'message') await transformMessage(item);
      return item;
    },
    commit: item => {
      if (item.dropped || !item.event) return;
      const event = item.event;

      if (event.type === 'message') {
        if (deps.isBlocked(event.chatId, event.sender?.id)) {
          const blocked = deps.toBlockedMessageEvent(event);
          log.withFields({ chatId: event.chatId, messageId: event.messageId }).debug('Redacted OneBot message from blocked user');
          deps.persistEvent(blocked);
          const rc = deps.pushPipelineEvent(event.chatId, blocked);
          deps.onDriverEvent(event.chatId, rc);
          return;
        }

        const text = contentToPlainText(event.content).trim();
        if (text === '/offline' || text === '/online') {
          const off = text === '/offline';
          deps.setOfflineMode(event.chatId, off);
          const reply = off
            ? 'Offline mode enabled. I will only respond when @mentioned or replied to, then automatically return online.'
            : 'Online mode enabled.';
          void deps.sendPlatformMessage(event.chatId, reply)
            .catch(err => log.withError(err).warn('Failed to send offline/online ack'));
          return;
        }
        if (text === '/compact') {
          const compaction = deps.requestCompaction(event.chatId);
          void (async () => {
            try {
              await deps.sendPlatformMessage(event.chatId, 'Compacting conversation context. Messages will not be processed until compaction completes.');
            } catch (err) {
              log.withError(err).withFields({ chatId: event.chatId }).warn('Failed to send manual compaction start notice');
            }
            try {
              const result = await compaction;
              const reply = result.status === 'completed'
                ? 'Context compaction complete.'
                : result.reason === 'no_content'
                  ? 'Nothing to compact.'
                  : 'Nothing to compact: context is already within the working window.';
              await deps.sendPlatformMessage(event.chatId, reply);
            } catch (err) {
              log.withError(err).withFields({ chatId: event.chatId }).error('Manual context compaction failed');
              try {
                await deps.sendPlatformMessage(event.chatId, 'Context compaction failed. Check the logs for details.');
              } catch (sendErr) {
                log.withError(sendErr).warn('Failed to send manual compaction failure ack');
              }
            }
          })();
          return;
        }
      }

      deps.persistEvent(event);
      deps.hydrateAltTextFromCache(event);
      const rc = deps.pushPipelineEvent(event.chatId, event);
      deps.onDriverEvent(event.chatId, rc);
    },
  });

  return {
    enqueue: (raw, meta) => {
      if (raw.post_type === 'notice') {
        // Notice adaptation is pure/synchronous; resolve it now so we can both
        // key the queue by chatId and skip events that adapt to nothing.
        const event = adaptOneBotNotice(raw, meta);
        if (!event) return;
        if (!deps.isWhitelisted(event.chatId)) return;
        queue.enqueue({ chatId: event.chatId, raw, meta, event });
        return;
      }

      const chatId = oneBotMessageChatId(raw);
      if (!deps.isWhitelisted(chatId)) return;
      // Dedup only message events (notices are deletes/services with no stable
      // per-message identity to persist). A message seen via the live WS during
      // the cold-start history pull window must not also be admitted from
      // get_group_msg_history, and vice versa.
      if (!deps.dedup.tryAdd(chatId, raw.message_id)) return;
      queue.enqueue({ chatId, raw, meta });
    },
  };
};
