import type { Logger } from '@guiiai/logg';

import { resolveOneBotImageAltText } from './image-to-text';
import type { OneBotApiClient } from './server';
import type { CanonicalAttachment } from '../adaption-types';
import type { loadCompaction, loadEventsWithId } from '../db';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import { contentToPlainText } from '../telegram/adaption';

export interface OneBotPostStartupTasks {
  run(): Promise<void>;
}

export interface OneBotPostStartupDeps {
  logger: Logger;
  getApi: () => OneBotApiClient | null;
  imageToTextChatIds: ReadonlySet<string>;
  imageToTextResolver: ImageToTextResolver;
  animationToTextResolver: AnimationToTextResolver;
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
  resolveChatPlatform: (chatId: string) => string;
  loadCompaction: (chatId: string) => ReturnType<typeof loadCompaction>;
  loadEventsWithId: (chatId: string, afterMs?: number) => ReturnType<typeof loadEventsWithId>;
  updateEventAttachments: (eventId: number, attachments: CanonicalAttachment[]) => void;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  replayChat: (chatId: string, events: PipelineEvent[]) => RenderedContext;
  getRenderedContext: (chatId: string) => RenderedContext | undefined;
  onDriverEvent: (chatId: string, rc: RenderedContext) => void;
}

const BACKFILLABLE_TYPES: ReadonlySet<CanonicalAttachment['type']> = new Set(['photo', 'sticker', 'animation']);

export const createOneBotPostStartupTasks = (deps: OneBotPostStartupDeps): OneBotPostStartupTasks => {
  // Images/animations that entered the DB while image-to-text was disabled (or
  // whose live resolution was dropped by the bounded-retry budget) carry no alt
  // text. This walks persisted history once on cold start and resolves the gaps.
  //
  // Best-effort, mirroring Telegram's async cold-start hydration: per CLAUDE.md
  // the live ingress path is fail-closed (bounded-retry-then-drop), but historical
  // backfill must never abort startup — old QQ media references are frequently
  // already expired, so a download/LLM failure is caught, logged, and skipped.
  // Unlike Telegram (which queries alt text from the cache at render time),
  // OneBot bakes resolved alt text directly into the persisted event attachments,
  // so we persist the mutated attachments back via updateEventAttachments.
  const backfillAltText = async () => {
    if (deps.imageToTextChatIds.size === 0) return;

    const backfillLog = deps.logger.withContext('onebot:alt-text-backfill');

    for (const chatId of deps.imageToTextChatIds) {
      if (deps.resolveChatPlatform(chatId) !== 'onebot') continue;

      const api = deps.getApi();
      if (!api) {
        backfillLog.withFields({ chatId }).warn('Skipping alt-text backfill: OneBot API client unavailable');
        continue;
      }

      const compaction = deps.loadCompaction(chatId);
      const eventsWithId = deps.loadEventsWithId(chatId, compaction?.newCursorMs);
      const compression = deps.getImageToTextCompression(chatId);

      let resolvedCount = 0;
      for (const { id: eventId, event } of eventsWithId) {
        if (event.type !== 'message' && event.type !== 'edit') continue;

        const pending = event.attachments.filter(att =>
          !att.altText && att.fileRef && BACKFILLABLE_TYPES.has(att.type));
        if (pending.length === 0) continue;

        const caption = contentToPlainText(event.content);
        let updated = false;
        for (const att of pending) {
          try {
            await resolveOneBotImageAltText(
              att, caption, api, deps.imageToTextResolver, deps.animationToTextResolver, compression,
              { chatId, messageId: event.messageId, attachmentIndex: event.attachments.indexOf(att) },
            );
            if (att.altText) {
              updated = true;
              resolvedCount++;
            }
          } catch (err) {
            backfillLog.withError(err).withFields({ chatId, eventId, messageId: event.messageId })
              .warn('OneBot alt-text backfill failed; keeping event without alt text');
          }
        }

        if (updated) deps.updateEventAttachments(eventId, event.attachments);
      }

      if (resolvedCount > 0) {
        backfillLog.withFields({ chatId, resolved: resolvedCount }).log('Backfilled OneBot alt text');
        const refreshed = deps.loadEventsWithId(chatId, compaction?.newCursorMs).map(e => e.event);
        for (const event of refreshed) deps.hydrateAltTextFromCache(event);
        deps.replayChat(chatId, refreshed);
        const rc = deps.getRenderedContext(chatId);
        if (rc) deps.onDriverEvent(chatId, rc);
      }
    }
  };

  return {
    run: async () => {
      await backfillAltText();
    },
  };
};
