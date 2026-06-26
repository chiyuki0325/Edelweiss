import type { Logger } from '@guiiai/logg';

import { contentToPlainText } from './adaption';
import type { ContentNode } from '../adaption-types';
import type { loadCompaction, loadEvents, loadEventsWithId, loadMessageFileId, updateEventAttachments } from '../db';
import { canExtractFrames, extractFrames } from '../media';
import type { AnimationToTextResolver, CustomEmojiToTextResolver } from '../media';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import type { TelegramManager } from './manager';
import type { Attachment } from './message/types';

export interface TelegramPostStartupTasks {
  run(): Promise<void>;
}

export interface TelegramPostStartupDeps {
  manager: TelegramManager;
  logger: Logger;
  animationToTextChatIds: ReadonlySet<string>;
  animationToTextResolver: AnimationToTextResolver;
  customEmojiToTextChatIds: ReadonlySet<string>;
  customEmojiToTextResolver: CustomEmojiToTextResolver;
  animationMaxFrames: number;
  resolveChatPlatform: (chatId: string) => string;
  blockedSenderIdsForChat: (chatId: string) => ReadonlySet<string> | undefined;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  walkCustomEmoji: (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => void;
  replayChat: (chatId: string, events: PipelineEvent[]) => RenderedContext;
  loadCompaction: (chatId: string) => ReturnType<typeof loadCompaction>;
  loadEvents: (chatId: string, afterMs?: number) => ReturnType<typeof loadEvents>;
  loadEventsWithId: (chatId: string, afterMs?: number) => ReturnType<typeof loadEventsWithId>;
  loadMessageFileId: (chatId: string, messageId: number) => ReturnType<typeof loadMessageFileId>;
  updateEventAttachments: (eventId: number, attachments: Parameters<typeof updateEventAttachments>[2]) => void;
}

export const createTelegramPostStartupTasks = (deps: TelegramPostStartupDeps): TelegramPostStartupTasks => {
  const backfillAnimationHashes = async () => {
    if (deps.animationToTextChatIds.size === 0) return;

    const backfillLog = deps.logger.withContext('animation-backfill');
    for (const chatId of deps.animationToTextChatIds) {
      if (deps.resolveChatPlatform(chatId) !== 'telegram') continue;
      const compaction = deps.loadCompaction(chatId);
      const eventsWithId = deps.loadEventsWithId(chatId, compaction?.newCursorMs);
      const tasks: Promise<void>[] = [];
      for (const { id: eventId, event } of eventsWithId) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        for (const att of event.attachments) {
          if (att.animationHash || att.type === 'photo') continue;
          const isAnimation = att.type === 'animation';
          const isLikelyAnimatedSticker = att.type === 'sticker' && !att.thumbnailWebp;
          if (!isAnimation && !isLikelyAnimatedSticker) continue;

          const caption = contentToPlainText(event.content);
          tasks.push((async () => {
            try {
              const messageId = parseInt(event.messageId, 10);
              if (isNaN(messageId)) return;

              let buffer = await deps.manager.userbot?.downloadMessageMedia(chatId, messageId);
              if (!buffer) {
                const fileId = deps.loadMessageFileId(chatId, messageId);
                if (fileId) buffer = await deps.manager.bot.downloadFile(fileId);
              }
              if (!buffer) {
                backfillLog.withFields({ chatId, messageId }).warn('Backfill skipped: download failed');
                return;
              }

              const syntheticAtt: Attachment = {
                type: att.type as 'animation' | 'sticker',
                isVideoSticker: isLikelyAnimatedSticker,
                mimeType: att.mimeType,
              };
              if (!canExtractFrames(syntheticAtt)) return;

              const { frames, cacheKey, frameTimestamps } = await extractFrames(buffer, syntheticAtt, deps.animationMaxFrames);
              att.animationHash = cacheKey;
              deps.updateEventAttachments(eventId, event.attachments);

              await deps.animationToTextResolver.resolve({
                cacheKey,
                frames,
                caption,
                isSticker: att.type === 'sticker',
                stickerSetName: att.stickerSetName,
                duration: att.duration,
                frameTimestamps,
              });
            } catch (err) {
              backfillLog.withError(err).warn('Failed to backfill animation');
            }
          })());
        }
      }
      if (tasks.length > 0) {
        backfillLog.withFields({ chatId, tasks: tasks.length }).log('Backfilling animation hashes');
        await Promise.all(tasks);
      }
    }
  };

  const resolveCustomEmojiDescriptions = async () => {
    if (deps.customEmojiToTextChatIds.size === 0) return;

    for (const chatId of deps.customEmojiToTextChatIds) {
      const compaction = deps.loadCompaction(chatId);
      const blockedSenderIds = deps.blockedSenderIdsForChat(chatId);
      const events = deps.loadEvents(chatId, compaction?.newCursorMs)
        .filter(e => {
          if (!('sender' in e) || !e.sender?.id) return true;
          return !blockedSenderIds?.has(e.sender.id);
        });
      const emojiIds = new Map<string, string>();
      for (const event of events) {
        if (event.type !== 'message' && event.type !== 'edit') continue;
        deps.walkCustomEmoji(event.content, node => {
          if (!emojiIds.has(node.customEmojiId)) {
            const fallback = contentToPlainText(node.children);
            emojiIds.set(node.customEmojiId, fallback);
          }
        });
      }
      if (emojiIds.size > 0) {
        deps.logger.withFields({ chatId, count: emojiIds.size }).log('Cold-start: resolving custom emoji descriptions');
        await deps.customEmojiToTextResolver.resolve(emojiIds);
        for (const event of events) deps.hydrateAltTextFromCache(event);
        deps.replayChat(chatId, events);
      }
    }
  };

  return {
    run: async () => {
      await backfillAnimationHashes();
      await resolveCustomEmojiDescriptions();
    },
  };
};
