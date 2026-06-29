import type { Logger } from '@guiiai/logg';

import type { BotClient, MediaGroupItem, MediaSendOptions, SendOptions, SentMessage } from './bot';
import { createBotClient } from './bot';
import { createEventBus } from './event-bus';
import { createMessageDedup, mergeTelegramMessageData } from './message';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramReactionUpdate, Attachment, MessageEntity } from './message';
import { normalizeStickerSetMetadata } from './pack-title';
import { loadSession } from './session';
import type { TypingPollManager } from './typing-poll';
import { createTypingPollManager } from './typing-poll';
import type { FetchOptions, TypingEvent, UserbotClient } from './userbot';
import { createUserbotClient } from './userbot';
import type { Config } from '../config/config';
import { createSessionIngressQueue } from '../ingress/session-ingress-queue';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { CustomEmojiToTextResolver } from '../media/custom-emoji-to-text';
import { canExtractFrames, extractFrames } from '../media/frame-extractor';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import { canGenerateThumbnail, generateThumbnail } from '../media/thumbnail';

export interface TelegramManagerOptions {
  botToken: string;
  apiId?: number;
  apiHash?: string;
  session?: string;
  initialChatIds?: string[];
  resolveChatId?: (messageIds: number[]) => string | undefined;
  imageToText?: ImageToTextResolver;
  imageToTextChatIds?: Set<string>;
  getImageToTextCompression?: (chatId: string) => ImageToTextCompressionConfig;
  animationToText?: AnimationToTextResolver;
  animationToTextChatIds?: Set<string>;
  animationMaxFrames?: number;
  customEmojiToText?: CustomEmojiToTextResolver;
  customEmojiToTextChatIds?: Set<string>;
}

export interface TelegramManagerDeps {
  config: Config;
  logger: Logger;
  telegramIngressChatIds: string[];
  resolveChatId: (messageIds: number[]) => string | undefined;
  imageToTextChatIds: ReadonlySet<string>;
  imageToTextResolver: ImageToTextResolver;
  animationToTextChatIds: ReadonlySet<string>;
  animationToTextResolver: AnimationToTextResolver;
  customEmojiToTextChatIds: ReadonlySet<string>;
  customEmojiToTextResolver: CustomEmojiToTextResolver;
  animationMaxFrames: number;
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
}

type IngressEvent =
  | { kind: 'message'; chatId: string; message: TelegramMessage }
  | { kind: 'edit'; chatId: string; edit: TelegramMessageEdit }
  | { kind: 'delete'; chatId: string; del: TelegramMessageDelete }
  | { kind: 'reaction'; chatId: string; reaction: TelegramReactionUpdate };

const captureIngressMeta = () => ({
  receivedAtMs: Date.now(),
  utcOffsetMin: -new Date().getTimezoneOffset(),
});

export interface TelegramManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  onReactionUpdate: (handler: (update: TelegramReactionUpdate) => void) => void;
  onTyping: (handler: (event: TypingEvent) => void) => void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendDocument(chatId: string | number, document: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideo(chatId: string | number, video: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAudio(chatId: string | number, audio: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVoice(chatId: string | number, voice: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAnimation(chatId: string | number, animation: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideoNote(chatId: string | number, videoNote: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendMediaGroup(chatId: string | number, media: MediaGroupItem[], options?: SendOptions): Promise<SentMessage[]>;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  startTypingPolling(chatId: string): void;
  stopTypingPolling(chatId: string): void;
  resolvePackTitle(setName: string): Promise<string>;
  refreshAllowedReactionEmojis(chatId: string, signal?: AbortSignal): Promise<string[]>;
  getAllowedReactionEmojis(chatId: string): string[];
  sendReaction(chatId: string, messageId: number, emoji: string): Promise<void>;
  botUserId: string;
  bot: BotClient;
  userbot?: UserbotClient;
}

export const createTelegramManager = (
  options: TelegramManagerOptions,
  logger: Logger,
): TelegramManager => {
  const log = logger.withContext('telegram:manager');
  const bot = createBotClient({ token: options.botToken }, logger);
  const userbot = (options.apiId != null && options.apiHash != null)
    ? createUserbotClient({
        apiId: options.apiId,
        apiHash: options.apiHash,
        session: options.session ?? '',
      }, logger)
    : undefined;

  const dedup = createMessageDedup();
  const botChats = new Set<string>(options.initialChatIds);
  const inflight = new Map<string, TelegramMessage>();
  const messageBus = createEventBus<TelegramMessage>('telegram:message', logger);
  const editBus = createEventBus<TelegramMessageEdit>('telegram:edit', logger);
  const deleteBus = createEventBus<TelegramMessageDelete>('telegram:delete', logger);
  const reactionBus = createEventBus<TelegramReactionUpdate>('telegram:reaction', logger);
  const typingBus = createEventBus<TypingEvent>('telegram:typing', logger);

  // Unified download: fileId → Bot API, else → userbot by chatId+messageId
  const downloadAttachmentMedia = async (
    chatId: string,
    messageId: number,
    att: Attachment,
  ): Promise<Buffer | undefined> => {
    if (att.fileId) {
      return await bot.downloadFile(att.fileId);
    }
    return await userbot?.downloadMessageMedia(chatId, messageId);
  };

  const imageToText = options.imageToText;
  const imageToTextChatIds = options.imageToTextChatIds;
  const getImageToTextCompression = options.getImageToTextCompression;
  const animationToText = options.animationToText;
  const animationToTextChatIds = options.animationToTextChatIds;
  const animationMaxFrames = options.animationMaxFrames;
  const customEmojiToText = options.customEmojiToText;
  const customEmojiToTextChatIds = options.customEmojiToTextChatIds;

  // Pack title cache: set_name → display title (in-process, never changes)
  const packTitleCache = new Map<string, string>();
  const packTitleInflight = new Map<string, Promise<string>>();
  const resolvePackTitle = async (setName: string): Promise<string> => {
    const cached = packTitleCache.get(setName);
    if (cached) return cached;
    const inflight = packTitleInflight.get(setName);
    if (inflight) return await inflight;

    const task = (async () => {
      try {
        const stickerSet = await bot.raw().api.getStickerSet(setName);
        packTitleCache.set(setName, stickerSet.title);
        return stickerSet.title;
      } catch (err) {
        log.withError(err).withFields({ setName }).warn('Failed to resolve pack title');
        return setName;
      } finally {
        packTitleInflight.delete(setName);
      }
    })();

    packTitleInflight.set(setName, task);
    return await task;
  };

  const hydrateAttachments = async (
    chatId: string,
    messageId: number,
    text: string,
    attachments?: Attachment[],
    entities?: MessageEntity[],
  ) => {
    if (attachments) {
      // Phase 0: Normalize sticker pack metadata once: raw set_name -> display title.
      await normalizeStickerSetMetadata(attachments, resolvePackTitle);

      // Phase 1: Download media + generate thumbnails for eligible attachments.
      // Keep original buffers for high-res LLM input later.
      const originalBuffers = new Map<Attachment, Buffer>();
      await Promise.all(attachments.map(async att => {
        if (att.thumbnailWebp || !canGenerateThumbnail(att)) return;
        try {
          const buffer = await downloadAttachmentMedia(chatId, messageId, att);
          if (buffer) {
            originalBuffers.set(att, buffer);
            att.thumbnailWebp = await generateThumbnail(buffer);
          }
        } catch (err) {
          log.withError(err).warn('Failed to generate thumbnail');
        }
      }));

      // Phase 2: Call image-to-text resolver for each attachment with a thumbnail.
      if (imageToText && (!imageToTextChatIds || imageToTextChatIds.has(chatId))) {
        await Promise.all(attachments.map(async att => {
          if (!att.thumbnailWebp) return;
          const thumbnailBuffer = Buffer.from(att.thumbnailWebp, 'base64');
          const highResBuffer = originalBuffers.get(att);
          await imageToText.resolve(thumbnailBuffer, text, highResBuffer, {
            isSticker: att.type === 'sticker',
            compression: getImageToTextCompression?.(chatId),
          });
        }));
      }

      // Phase 3: Download animation media, extract frames, call animation-to-text resolver.
      // Sets animationHash on the Attachment so it propagates through adaptation and persists in events.
      if (animationToText && (!animationToTextChatIds || animationToTextChatIds.has(chatId))) {
        await Promise.all(attachments.map(async att => {
          if (!canExtractFrames(att)) return;
          try {
            const buffer = await downloadAttachmentMedia(chatId, messageId, att);
            if (!buffer) return;
            const { frames, cacheKey, frameTimestamps } = await extractFrames(buffer, att, animationMaxFrames);
            att.animationHash = cacheKey;
            await animationToText.resolve({
              cacheKey,
              frames,
              caption: text,
              isSticker: att.type === 'sticker',
              emoji: att.emoji,
              stickerSetName: att.stickerSetName,
              duration: att.duration,
              frameTimestamps,
            });
          } catch (err) {
            log.withError(err).warn('Failed to process animation-to-text');
          }
        }));
      }
    }

    // Phase 4: Resolve custom emoji descriptions from entities.
    if (customEmojiToText && (!customEmojiToTextChatIds || customEmojiToTextChatIds.has(chatId)) && entities) {
      const emojiIds = new Map<string, string>();
      for (const ent of entities) {
        if (ent.type === 'custom_emoji' && ent.customEmojiId) {
          // Extract fallback emoji text from the message text using entity offset/length
          const fallback = text.substring(ent.offset, ent.offset + ent.length);
          emojiIds.set(ent.customEmojiId, fallback);
        }
      }
      if (emojiIds.size > 0) {
        await customEmojiToText.resolve(emojiIds);
      }
    }
  };

  const ingressQueue = createSessionIngressQueue<IngressEvent>({
    logger,
    logContext: 'telegram:ingress-queue',
    transform: async event => {
      switch (event.kind) {
      case 'message':
        await hydrateAttachments(event.chatId, event.message.messageId, event.message.text, event.message.attachments, event.message.entities);
        return event;
      case 'edit':
        await hydrateAttachments(event.chatId, event.edit.messageId, event.edit.text, event.edit.attachments, event.edit.entities);
        return event;
      case 'delete':
        return event;
      case 'reaction':
        if (event.reaction.kind === 'count' && userbot) {
          try {
            return {
              ...event,
              reaction: {
                ...event.reaction,
                snapshot: await userbot.fetchMessageReactions(event.reaction.chatId, event.reaction.messageId),
              },
            };
          } catch (err) {
            log.withError(err).withFields({
              chatId: event.reaction.chatId,
              messageId: event.reaction.messageId,
            }).warn('Failed to fetch Telegram message reaction actors');
          }
        }
        return event;
      }
    },
    commit: event => {
      switch (event.kind) {
      case 'message':
        inflight.delete(`${event.chatId}:${event.message.messageId}`);
        messageBus.emit(event.message);
        break;
      case 'edit':
        editBus.emit(event.edit);
        break;
      case 'delete':
        deleteBus.emit(event.del);
        break;
      case 'reaction':
        reactionBus.emit(event.reaction);
        break;
      }
    },
  });

  const dispatchMessage = (msg: TelegramMessage) => {
    const key = `${msg.chatId}:${msg.messageId}`;

    if (!dedup.tryAdd(msg.chatId, msg.messageId)) {
      // Second arrival — if bot version, merge richer Bot API metadata into
      // the in-flight userbot message while preserving any userbot-only fields.
      if (msg.source === 'bot') {
        const existing = inflight.get(key);
        if (existing) mergeTelegramMessageData(existing, msg);
      }
      return;
    }

    const enriched = { ...msg, ...captureIngressMeta() };
    inflight.set(key, enriched);
    ingressQueue.enqueue({ kind: 'message', chatId: enriched.chatId, message: enriched });
  };

  bot.onMessage(msg => {
    botChats.add(msg.chatId);
    dispatchMessage(msg);
  });

  bot.onReactionUpdate(reaction => {
    if (!botChats.has(reaction.chatId)) return;
    ingressQueue.enqueue({
      kind: 'reaction',
      chatId: reaction.chatId,
      reaction: { ...reaction, ...captureIngressMeta() },
    });
  });

  const handleTypingEvent = (event: TypingEvent) => {
    if (!botChats.has(event.chatId)) return;
    logger.withFields({ chatId: event.chatId, userId: event.userId }).debug('Telegram typing event received');
    typingBus.emit(event);
  };

  if (userbot) {
    userbot.onMessage(msg => {
      if (!botChats.has(msg.chatId)) return;
      dispatchMessage(msg);
    });

    userbot.onMessageEdit(edit => {
      if (!botChats.has(edit.chatId)) return;
      ingressQueue.enqueue({
        kind: 'edit',
        chatId: edit.chatId,
        edit: { ...edit, ...captureIngressMeta() },
      });
    });

    userbot.onMessageDelete(del => {
      const chatId = del.chatId ?? options.resolveChatId?.(del.messageIds);
      if (!chatId || !botChats.has(chatId)) return;
      ingressQueue.enqueue({
        kind: 'delete',
        chatId,
        del: { ...del, chatId, ...captureIngressMeta() },
      });
    });

    userbot.onTyping(handleTypingEvent);
  }

  let typingPollManager: TypingPollManager | undefined;
  if (userbot) {
    typingPollManager = createTypingPollManager(userbot.raw(), handleTypingEvent, logger);
  }

  const startTypingPolling = (chatId: string) => {
    if (!typingPollManager) return;
    void typingPollManager.startPolling(chatId);
  };

  const stopTypingPolling = (chatId: string) => {
    typingPollManager?.stopPolling(chatId);
  };

  const start = async () => {
    await Promise.all([
      bot.start(),
      userbot?.start(),
    ]);
  };

  const stop = async () => {
    await typingPollManager?.stopAll();
    await Promise.all([
      bot.stop(),
      userbot?.stop(),
    ]);
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    onReactionUpdate: reactionBus.on,
    onTyping: typingBus.on,
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    sendPhoto: (chatId, photo, opts) => bot.sendPhoto(chatId, photo, opts),
    sendDocument: (chatId, doc, opts) => bot.sendDocument(chatId, doc, opts),
    sendVideo: (chatId, video, opts) => bot.sendVideo(chatId, video, opts),
    sendAudio: (chatId, audio, opts) => bot.sendAudio(chatId, audio, opts),
    sendVoice: (chatId, voice, opts) => bot.sendVoice(chatId, voice, opts),
    sendAnimation: (chatId, anim, opts) => bot.sendAnimation(chatId, anim, opts),
    sendVideoNote: (chatId, note, opts) => bot.sendVideoNote(chatId, note, opts),
    sendMediaGroup: (chatId, media, opts) => bot.sendMediaGroup(chatId, media, opts),
    fetchMessages: (chatId, opts) => userbot?.fetchMessages(chatId, opts) ?? Promise.resolve([]),
    fetchSpecificMessages: (chatId, ids) => userbot?.fetchSpecificMessages(chatId, ids) ?? Promise.resolve([]),
    resolvePackTitle,
    refreshAllowedReactionEmojis: (chatId, signal) => userbot?.refreshAllowedReactionEmojis(chatId, signal) ?? Promise.resolve([]),
    getAllowedReactionEmojis: chatId => userbot?.getAllowedReactionEmojis(chatId) ?? [],
    sendReaction: (chatId, messageId, emoji) => bot.sendReaction(chatId, messageId, emoji),
    botUserId: bot.botUserId(),
    bot,
    userbot,
    startTypingPolling,
    stopTypingPolling,
  };
};

export const createTelegramStartupManager = (deps: TelegramManagerDeps): TelegramManager | undefined => {
  if (!deps.config.telegram) return undefined;

  const hasUserbot = deps.config.telegram.apiId != null && deps.config.telegram.apiHash != null;
  return createTelegramManager({
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
};
