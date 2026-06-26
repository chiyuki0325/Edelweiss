import { execFile } from 'node:child_process';

import type { Logger } from '@guiiai/logg';

import { adaptDelete, adaptEdit, adaptMessage, adaptReaction, adaptServiceEvent, contentToPlainText, isServiceMessage } from '../adaptation';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent, ContentNode } from '../adaptation/types';
import type { Config, RuntimeConfig } from '../config/config';
import type { loadCompaction, loadEvents, loadEventsWithId, loadLatestMessageContent, loadMessageFileId, loadMessageReactionSnapshot, persistMessage, persistMessageDelete, persistMessageEdit, updateEventAttachments } from '../db';
import { createAnimationToTextResolver, createCustomEmojiToTextResolver, canExtractFrames, extractFrames } from '../media';
import type { AnimationToTextResolver, CustomEmojiToTextResolver, ImageToTextCompressionConfig, ImageToTextResolver } from '../media';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import type { SentMessage as TelegramSentMessage } from './bot';
import { createTelegramManager } from './index';
import { renderMarkdownToTelegramHTML } from './markdown';
import type { Attachment, TelegramReactionSnapshotEntry, TelegramReactionUpdate } from './message/types';
import { loadSession } from './session';
import { isConfiguredChat } from '../startup/chat-selection';

export interface TelegramDriverHooks {
  sendMessage(chatId: string, text: string, replyToMessageId?: number, attachments?: {
    type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
    path: string;
    file_name?: string;
  }[]): Promise<TelegramSentMessage>;
  loadMessageAttachments(chatId: string, messageId: number): Attachment[] | undefined;
  downloadFile(fileId: string): Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  refreshAllowedReactionEmojis?: (chatId: string) => Promise<string[]>;
  getAllowedReactionEmojis?: (chatId: string) => string[];
  sendReaction(chatId: string, messageId: number, emoji: string): Promise<void>;
  onDebounceStateChange(chatId: string, isDebouncing: boolean): void;
}

export interface TelegramStartupDeps {
  config: Config;
  runtimeConfig: RuntimeConfig;
  logger: Logger;
  botUserId: string;
  configuredChatIds: ReadonlySet<string>;
  telegramIngressChatIds: string[];
  resolveChatId: (messageIds: number[]) => string | undefined;
  imageToTextChatIds: ReadonlySet<string>;
  imageToTextResolver: ImageToTextResolver;
  animationToTextChatIds: ReadonlySet<string>;
  animationToTextResolver: AnimationToTextResolver;
  customEmojiToTextChatIds: ReadonlySet<string>;
  customEmojiToTextResolver: CustomEmojiToTextResolver;
  customEmojiMaxFrames: number;
  animationMaxFrames: number;
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
  resolveChatPlatform: (chatId: string) => string;
  isBlocked: (chatId: string, senderId: string | undefined) => boolean;
  toBlockedMessageEvent: (event: CanonicalMessageEvent) => CanonicalBlockedMessageEvent;
  blockedSenderIdsForChat: (chatId: string) => ReadonlySet<string> | undefined;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  walkCustomEmoji: (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => void;
  persistEvent: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext;
  replayChat: (chatId: string, events: PipelineEvent[]) => RenderedContext;
  getIntermediateContext: (chatId: string) => { nodes: Array<{ type: string; messageId?: string }> } | undefined;
  onDriverEvent: (chatId: string, rc: RenderedContext) => void;
  handleTyping: (chatId: string, userId: string) => void;
  setOfflineMode: (chatId: string, offline: boolean) => void;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  loadCompaction: (chatId: string) => ReturnType<typeof loadCompaction>;
  loadEvents: (chatId: string, afterMs?: number) => ReturnType<typeof loadEvents>;
  loadEventsWithId: (chatId: string, afterMs?: number) => ReturnType<typeof loadEventsWithId>;
  loadLatestMessageContent: (chatId: string, messageId: string) => ReturnType<typeof loadLatestMessageContent>;
  loadMessageFileId: (chatId: string, messageId: number) => ReturnType<typeof loadMessageFileId>;
  loadMessageReactionSnapshot: (chatId: string, messageId: string) => ReturnType<typeof loadMessageReactionSnapshot>;
  persistMessage: (msg: Parameters<typeof persistMessage>[1]) => void;
  persistMessageEdit: (edit: Parameters<typeof persistMessageEdit>[1]) => void;
  persistMessageDelete: (del: Parameters<typeof persistMessageDelete>[1]) => void;
  updateEventAttachments: (eventId: number, attachments: Parameters<typeof updateEventAttachments>[2]) => void;
  upsertMessageReactionSnapshot: (chatId: string, messageId: string, entries: TelegramReactionSnapshotEntry[], updatedAtMs: number) => void;
}

export interface TelegramStartupHandle {
  manager: ReturnType<typeof createTelegramManager>;
  driverHooks: TelegramDriverHooks;
  startLiveHandlers(): Promise<void>;
  runPostStartupTasks(): Promise<void>;
  stop(): Promise<void>;
}

const readWorkspaceFile = (runtimeConfig: RuntimeConfig, path: string): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const cmd = runtimeConfig.readFile;
    const child = execFile(
      cmd[0]!,
      [...cmd.slice(1), path],
      { timeout: 60_000, maxBuffer: runtimeConfig.readFileSizeLimit + 1024, encoding: 'buffer' as BufferEncoding },
      (error, stdout) => {
        if (error) return reject(new Error(`readFile failed: ${error.message}`));
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (buf.length > runtimeConfig.readFileSizeLimit)
          return reject(new Error(`File too large: ${buf.length} bytes exceeds limit of ${runtimeConfig.readFileSizeLimit} bytes`));
        resolve(buf);
      },
    );
    child.stdin?.end();
  });

export const createTelegramCustomEmojiResolver = (deps: {
  enabled: boolean;
  model: Parameters<typeof createCustomEmojiToTextResolver>[0]['model'];
  semaphore: Parameters<typeof createCustomEmojiToTextResolver>[0]['semaphore'];
  maxFrames: number;
  logger: Logger;
  lookupByHash: Parameters<typeof createCustomEmojiToTextResolver>[0]['lookupByHash'];
  persist: Parameters<typeof createCustomEmojiToTextResolver>[0]['persist'];
  managerRef: { telegram?: ReturnType<typeof createTelegramManager> };
}): CustomEmojiToTextResolver => createCustomEmojiToTextResolver({
  enabled: deps.enabled,
  model: deps.model,
  semaphore: deps.semaphore,
  maxFrames: deps.maxFrames,
  logger: deps.logger,
  lookupByHash: deps.lookupByHash,
  persist: deps.persist,
  getCustomEmojiStickers: async ids => {
    const bot = deps.managerRef.telegram!.bot.raw();
    return await bot.api.getCustomEmojiStickers(ids);
  },
  downloadFile: async fileId => await deps.managerRef.telegram!.bot.downloadFile(fileId),
  resolvePackTitle: async setName => await deps.managerRef.telegram!.resolvePackTitle(setName),
});

export const createTelegramAnimationResolver = createAnimationToTextResolver;

export const startTelegram = (deps: TelegramStartupDeps): TelegramStartupHandle | undefined => {
  if (!deps.config.telegram) return undefined;

  const hasUserbot = deps.config.telegram.apiId != null && deps.config.telegram.apiHash != null;
  const manager = createTelegramManager({
    botToken: deps.config.telegram.botToken,
    ...(hasUserbot ? {
      apiId: deps.config.telegram.apiId,
      apiHash: deps.config.telegram.apiHash,
      session: loadSession(deps.config.telegram.session ?? ''),
    } : {}),
    initialChatIds: deps.telegramIngressChatIds,
    resolveChatId: deps.resolveChatId,
    imageToText: deps.imageToTextChatIds.size > 0 ? deps.imageToTextResolver : undefined,
    imageToTextChatIds: new Set(deps.imageToTextChatIds),
    getImageToTextCompression: deps.getImageToTextCompression,
    animationToText: deps.animationToTextChatIds.size > 0 ? deps.animationToTextResolver : undefined,
    animationToTextChatIds: new Set(deps.animationToTextChatIds),
    animationMaxFrames: deps.animationMaxFrames,
    customEmojiToText: deps.customEmojiToTextChatIds.size > 0 ? deps.customEmojiToTextResolver : undefined,
    customEmojiToTextChatIds: new Set(deps.customEmojiToTextChatIds),
  }, deps.logger);

  const sendSingleMedia = async (
    chatId: string,
    type: string,
    buffer: Buffer,
    caption?: string,
    replyToMessageId?: number,
    fileName?: string,
  ) => {
    const opts = {
      caption,
      captionParseMode: caption ? 'HTML' as const : undefined,
      replyToMessageId,
      fileName,
    };
    switch (type) {
    case 'photo': return await manager.sendPhoto(chatId, buffer, opts);
    case 'video': return await manager.sendVideo(chatId, buffer, opts);
    case 'audio': return await manager.sendAudio(chatId, buffer, opts);
    case 'voice': return await manager.sendVoice(chatId, buffer, opts);
    case 'animation': return await manager.sendAnimation(chatId, buffer, opts);
    case 'video_note': return await manager.sendVideoNote(chatId, buffer, opts);
    case 'document':
    default: return await manager.sendDocument(chatId, buffer, { ...opts, fileName });
    }
  };

  const injectSyntheticEvent = (chatId: string, sent: { messageId: number; date: number; text: string; entities?: import('./message/types').MessageEntity[] }, replyToMessageId?: number) => {
    const botInfo = manager.bot.botInfo();
    const syntheticMsg = {
      messageId: sent.messageId,
      chatId,
      sender: {
        id: deps.botUserId,
        firstName: botInfo?.firstName ?? 'Bot',
        username: botInfo?.username,
        isBot: true,
        isPremium: false,
      },
      date: sent.date,
      text: sent.text,
      entities: sent.entities,
      replyToMessageId,
      source: 'bot' as const,
    };
    const event = adaptMessage(syntheticMsg);
    event.isSelfSent = true;

    const ic = deps.getIntermediateContext(chatId);
    if (ic?.nodes.some(n => n.type === 'message' && n.messageId === event.messageId))
      deps.logger.withFields({ chatId, messageId: event.messageId }).warn('Synthetic bypass: userbot arrived first (isSelfSent merged via dedup)');

    deps.persistEvent(event);
    deps.upsertMessageReactionSnapshot(chatId, event.messageId, [], event.receivedAtMs);
    deps.hydrateAltTextFromCache(event);
    if (isConfiguredChat(deps.configuredChatIds, chatId))
      deps.pushPipelineEvent(chatId, event);
  };

  const sendMessage: TelegramDriverHooks['sendMessage'] = async (chatId, text, replyToMessageId, attachments) => {
    if (!attachments || attachments.length === 0) {
      const sent = await manager.sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : undefined);
      injectSyntheticEvent(chatId, sent, replyToMessageId);
      return sent;
    }

    const buffers = await Promise.all(attachments.map(att => readWorkspaceFile(deps.runtimeConfig, att.path)));
    const htmlCaption = text ? renderMarkdownToTelegramHTML(text) : undefined;

    if (attachments.length === 1) {
      const att = attachments[0]!;
      const sent = await sendSingleMedia(chatId, att.type, buffers[0]!, htmlCaption, replyToMessageId, att.file_name);
      injectSyntheticEvent(chatId, sent, replyToMessageId);
      return sent;
    }

    const mediaGroupTypes = new Set(['photo', 'video', 'audio', 'document']);
    const media = attachments.map((att, i) => ({
      type: (mediaGroupTypes.has(att.type) ? att.type : 'document') as 'photo' | 'video' | 'audio' | 'document',
      buffer: buffers[i]!,
      fileName: att.file_name,
      caption: i === 0 ? htmlCaption : undefined,
      captionParseMode: i === 0 && htmlCaption ? 'HTML' as const : undefined,
    }));

    const sentMessages = await manager.sendMediaGroup(chatId, media, replyToMessageId ? { replyToMessageId } : undefined);
    for (const sent of sentMessages)
      injectSyntheticEvent(chatId, sent, replyToMessageId);
    return sentMessages[0]!;
  };

  const reactionEntryKey = (entry: TelegramReactionSnapshotEntry) =>
    `${entry.emoji}\u0000${entry.sender.id}`;

  const persistReactionEvent = (
    reaction: TelegramReactionUpdate,
    emoji: string,
    count: number,
    sender?: TelegramReactionSnapshotEntry['sender'],
  ) => {
    const event = adaptReaction(reaction, emoji, count, sender);
    deps.persistEvent(event);
    if (isConfiguredChat(deps.configuredChatIds, event.chatId))
      deps.pushPipelineEvent(event.chatId, event);
  };

  const persistEmptyReactionSnapshotIfUnseeded = (chatId: string, messageId: string, updatedAtMs: number) => {
    const existing = deps.loadMessageReactionSnapshot(chatId, messageId);
    if (!existing) deps.upsertMessageReactionSnapshot(chatId, messageId, [], updatedAtMs);
  };

  const startLiveHandlers = async () => {
    manager.onMessage(msg => {
      if (msg.source === 'userbot' && msg.sender?.id === deps.botUserId) {
        try {
          deps.persistMessage(msg);
          if (!msg.reactions || Object.keys(msg.reactions).length === 0)
            persistEmptyReactionSnapshotIfUnseeded(msg.chatId, String(msg.messageId), msg.receivedAtMs ?? Date.now());
        } catch (err) { deps.logger.withError(err).error('Failed to persist self message'); }
        return;
      }

      if (isServiceMessage(msg)) {
        const event = adaptServiceEvent(msg);
        if (event) {
          deps.logger.withFields({
            source: msg.source,
            chatId: msg.chatId,
            action: event.action.action,
          }).log('Service event received');

          deps.persistEvent(event);
          if (isConfiguredChat(deps.configuredChatIds, event.chatId)) {
            const rc = deps.pushPipelineEvent(event.chatId, event);
            deps.onDriverEvent(event.chatId, rc);
          }
        }
        return;
      }

      deps.logger.withFields({
        source: msg.source,
        chatId: msg.chatId,
        messageId: msg.messageId,
        sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
        text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
        length: msg.text.length,
      }).log('Message received');

      const event = adaptMessage(msg);
      if (deps.isBlocked(event.chatId, event.sender?.id)) {
        const blockedEvent = deps.toBlockedMessageEvent(event);
        deps.logger.withFields({ chatId: event.chatId, messageId: event.messageId }).debug('Redacted message from blocked user');
        deps.persistEvent(blockedEvent);
        if (isConfiguredChat(deps.configuredChatIds, blockedEvent.chatId)) {
          const rc = deps.pushPipelineEvent(blockedEvent.chatId, blockedEvent);
          deps.onDriverEvent(blockedEvent.chatId, rc);
        }
        return;
      }

      deps.persistEvent(event);

      try { deps.persistMessage(msg); } catch (err) { deps.logger.withError(err).error('Failed to persist message'); }
      if (!msg.reactions || Object.keys(msg.reactions).length === 0)
        persistEmptyReactionSnapshotIfUnseeded(event.chatId, event.messageId, msg.receivedAtMs ?? Date.now());

      if (isConfiguredChat(deps.configuredChatIds, event.chatId)) {
        deps.hydrateAltTextFromCache(event);
        const rc = deps.pushPipelineEvent(event.chatId, event);
        deps.onDriverEvent(event.chatId, rc);
      }
    });

    manager.onMessageEdit(edit => {
      deps.logger.withFields({
        chatId: edit.chatId,
        messageId: edit.messageId,
        sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
        text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
        length: edit.text.length,
      }).log('Message edited');

      if (deps.isBlocked(edit.chatId, edit.sender?.id)) {
        deps.logger.withFields({ chatId: edit.chatId, senderId: edit.sender?.id }).debug('Dropped edit from blocked user');
        return;
      }

      const event = adaptEdit(edit);
      const prev = deps.loadLatestMessageContent(event.chatId, event.messageId);
      if (prev?.type === 'blocked_message') {
        deps.logger.withFields({ chatId: event.chatId, messageId: event.messageId }).debug('Dropped edit for blocked message');
        return;
      }
      if (prev) {
        const newText = contentToPlainText(event.content) || null;
        const newContent = event.content.length > 0 ? event.content : null;
        const newAttachments = event.attachments.length > 0 ? event.attachments : null;
        if (prev.text === newText
          && JSON.stringify(prev.content) === JSON.stringify(newContent)
          && JSON.stringify(prev.attachments) === JSON.stringify(newAttachments)) {
          return;
        }
      }

      deps.persistEvent(event);
      try { deps.persistMessageEdit(edit); } catch (err) { deps.logger.withError(err).error('Failed to persist message edit'); }

      if (isConfiguredChat(deps.configuredChatIds, event.chatId)) {
        deps.hydrateAltTextFromCache(event);
        const rc = deps.pushPipelineEvent(event.chatId, event);
        deps.onDriverEvent(event.chatId, rc);
      }
    });

    manager.onMessageDelete(del => {
      deps.logger.withFields({ chatId: del.chatId ?? 'unknown', messageIds: del.messageIds }).log('Message deleted');

      const event = adaptDelete(del);
      deps.persistEvent(event);
      try { deps.persistMessageDelete(del); } catch (err) { deps.logger.withError(err).error('Failed to persist message delete'); }

      if (isConfiguredChat(deps.configuredChatIds, event.chatId)) {
        const rc = deps.pushPipelineEvent(event.chatId, event);
        deps.onDriverEvent(event.chatId, rc);
      }
    });

    manager.onReactionUpdate(reaction => {
      deps.logger.withFields({
        chatId: reaction.chatId,
        messageId: reaction.messageId,
        kind: reaction.kind,
        reactions: reaction.kind === 'count' ? Object.keys(reaction.counts).length : reaction.newReactions.length,
      }).debug('Message reaction update received');

      const messageId = String(reaction.messageId);
      const previous = deps.loadMessageReactionSnapshot(reaction.chatId, messageId);
      const updatedAtMs = reaction.receivedAtMs ?? Date.now();

      if (reaction.kind === 'user') {
        const oldReactions = new Set(reaction.oldReactions);
        const newReactions = [...new Set(reaction.newReactions)];
        const next = [
          ...(previous ?? []).filter(entry => entry.sender.id !== reaction.sender.id),
          ...newReactions.map(emoji => ({ emoji, sender: reaction.sender, date: reaction.date })),
        ];

        deps.upsertMessageReactionSnapshot(reaction.chatId, messageId, next, updatedAtMs);

        for (const emoji of newReactions) {
          if (oldReactions.has(emoji)) continue;
          if (deps.isBlocked(reaction.chatId, reaction.sender.id)) continue;
          persistReactionEvent(reaction, emoji, 1, reaction.sender);
        }
        return;
      }

      if (!reaction.snapshot) {
        deps.logger.withFields({ chatId: reaction.chatId, messageId: reaction.messageId }).debug('Reaction count update skipped because actor snapshot is unavailable');
        return;
      }

      deps.upsertMessageReactionSnapshot(reaction.chatId, messageId, reaction.snapshot, updatedAtMs);
      if (!previous) return;

      const oldKeys = new Set(previous.map(reactionEntryKey));
      for (const entry of reaction.snapshot) {
        if (oldKeys.has(reactionEntryKey(entry))) continue;
        if (deps.isBlocked(reaction.chatId, entry.sender.id)) continue;
        persistReactionEvent(reaction, entry.emoji, 1, entry.sender);
      }
    });

    manager.onTyping(event => {
      if (event.userId === deps.botUserId) return;
      deps.handleTyping(event.chatId, event.userId);
    });

    manager.bot.registerCommand('offline', 'Pause automatic responses (only respond to @mentions and replies)', async chatId => {
      deps.setOfflineMode(chatId, true);
      await manager.bot.sendMessage(chatId, 'Offline mode enabled. I will only respond when @mentioned or replied to, then automatically return online.');
    });

    manager.bot.registerCommand('online', 'Resume automatic responses', async chatId => {
      deps.setOfflineMode(chatId, false);
      await manager.bot.sendMessage(chatId, 'Online mode enabled.');
    });

    await manager.start();
  };

  const runPostStartupTasks = async () => {
    if (deps.animationToTextChatIds.size > 0) {
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

                let buffer = await manager.userbot?.downloadMessageMedia(chatId, messageId);
                if (!buffer) {
                  const fileId = deps.loadMessageFileId(chatId, messageId);
                  if (fileId) buffer = await manager.bot.downloadFile(fileId);
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
    }

    if (deps.customEmojiToTextChatIds.size > 0) {
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
    }
  };

  return {
    manager,
    driverHooks: {
      sendMessage,
      loadMessageAttachments: deps.loadMessageAttachments,
      downloadFile: fileId => manager.bot.downloadFile(fileId),
      downloadMessageMedia: manager.userbot
        ? (chatId, messageId) => manager.userbot!.downloadMessageMedia(chatId, messageId)
        : undefined,
      refreshAllowedReactionEmojis: manager.userbot
        ? chatId => manager.refreshAllowedReactionEmojis(chatId)
        : undefined,
      getAllowedReactionEmojis: manager.userbot
        ? chatId => manager.getAllowedReactionEmojis(chatId)
        : undefined,
      sendReaction: (chatId, messageId, emoji) => manager.sendReaction(chatId, messageId, emoji),
      onDebounceStateChange: (chatId, isDebouncing) => {
        if (deps.resolveChatPlatform(chatId) !== 'telegram') return;
        if (isDebouncing) {
          manager.startTypingPolling(chatId);
        } else {
          manager.stopTypingPolling(chatId);
        }
      },
    },
    startLiveHandlers,
    runPostStartupTasks,
    stop: () => manager.stop(),
  };
};
