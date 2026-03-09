import type { Message as GrammyMessage } from '@grammyjs/types';
import { Api } from 'telegram';

import type { Attachment, ForwardInfo, MessageEntity } from '../db/schema';

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  isBot: boolean;
  isPremium: boolean;
}

export interface TelegramMessage {
  messageId: number;
  chatId: string;
  sender?: TelegramUser;
  date: number;
  editDate?: number;
  text: string;
  entities?: MessageEntity[];
  replyToMessageId?: number;
  replyToTopId?: number;
  forwardInfo?: ForwardInfo;
  mediaGroupId?: string;
  viaBotId?: string;
  attachments?: Attachment[];
  source: 'bot' | 'userbot';
}

export interface TelegramMessageEdit {
  messageId: number;
  chatId: string;
  sender?: TelegramUser;
  date: number;
  editDate: number;
  text: string;
  entities?: MessageEntity[];
  replyToMessageId?: number;
  attachments?: Attachment[];
}

export interface TelegramMessageDelete {
  messageIds: number[];
  chatId?: string;
}

// --- gramjs peer → chatId ---

const resolveChatId = (peer: Api.TypePeer): string => {
  if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toJSNumber()}`;
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toJSNumber()}`;
  if (peer instanceof Api.PeerUser) return String(peer.userId.toJSNumber());
  throw new Error(`Unknown peer type: ${String(peer)}`);
};

// --- gramjs entity conversion ---

const ENTITY_CLASS_TO_TYPE: Record<string, string> = {
  MessageEntityUnknown: 'unknown',
  MessageEntityMention: 'mention',
  MessageEntityHashtag: 'hashtag',
  MessageEntityBotCommand: 'bot_command',
  MessageEntityUrl: 'url',
  MessageEntityEmail: 'email',
  MessageEntityBold: 'bold',
  MessageEntityItalic: 'italic',
  MessageEntityCode: 'code',
  MessageEntityPre: 'pre',
  MessageEntityTextUrl: 'text_link',
  MessageEntityMentionName: 'text_mention',
  InputMessageEntityMentionName: 'text_mention',
  MessageEntityPhone: 'phone_number',
  MessageEntityCashtag: 'cashtag',
  MessageEntityUnderline: 'underline',
  MessageEntityStrike: 'strikethrough',
  MessageEntityBankCard: 'bank_card',
  MessageEntitySpoiler: 'spoiler',
  MessageEntityCustomEmoji: 'custom_emoji',
  MessageEntityBlockquote: 'blockquote',
};

const convertGramjsEntities = (entities?: Api.TypeMessageEntity[]): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;

  return entities.map(e => {
    const type = ENTITY_CLASS_TO_TYPE[e.className] ?? e.className;
    const result: MessageEntity = {
      type,
      offset: e.offset,
      length: e.length,
    };

    if (e instanceof Api.MessageEntityTextUrl) result.url = e.url;
    if (e instanceof Api.MessageEntityPre) result.language = e.language;
    if (e instanceof Api.MessageEntityMentionName) result.userId = String(e.userId.toJSNumber());
    if (e instanceof Api.MessageEntityCustomEmoji) result.customEmojiId = String(e.documentId.toJSNumber());

    return result;
  });
};

// --- gramjs forward info ---

const convertGramjsForwardInfo = (fwd?: Api.TypeMessageFwdHeader): ForwardInfo | undefined => {
  if (!fwd || !(fwd instanceof Api.MessageFwdHeader)) return undefined;

  const info: ForwardInfo = { date: fwd.date };

  if (fwd.fromId) {
    if (fwd.fromId instanceof Api.PeerUser) {
      info.fromUserId = String(fwd.fromId.userId.toJSNumber());
    } else if (fwd.fromId instanceof Api.PeerChannel) {
      info.fromChatId = `-100${fwd.fromId.channelId.toJSNumber()}`;
      if (fwd.channelPost) info.fromMessageId = fwd.channelPost;
    } else if (fwd.fromId instanceof Api.PeerChat) {
      info.fromChatId = `-${fwd.fromId.chatId.toJSNumber()}`;
    }
  }

  if (fwd.fromName) info.senderName = fwd.fromName;

  return info;
};

// --- gramjs media → attachments ---

const convertGramjsMedia = (media?: Api.TypeMessageMedia): Attachment[] | undefined => {
  if (!media) return undefined;

  if (media instanceof Api.MessageMediaPhoto) {
    if (!media.photo || !(media.photo instanceof Api.Photo)) return undefined;
    const largest = media.photo.sizes
      .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
      .sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const attachment: Attachment = {
      type: 'photo',
      width: largest?.w,
      height: largest?.h,
      hasSpoiler: media.spoiler,
    };
    return [attachment];
  }

  if (media instanceof Api.MessageMediaDocument) {
    if (!media.document || !(media.document instanceof Api.Document)) return undefined;
    return [convertGramjsDocument(media.document, media.spoiler)];
  }

  return undefined;
};

const convertGramjsDocument = (doc: Api.Document, spoiler?: boolean): Attachment => {
  const stickerAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker,
  );
  const videoAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeVideo => a instanceof Api.DocumentAttributeVideo,
  );
  const audioAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio,
  );
  const filenameAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
  );
  const isAnimated = doc.attributes.some(a => a instanceof Api.DocumentAttributeAnimated);
  const isCustomEmoji = doc.attributes.find(
    (a): a is Api.DocumentAttributeCustomEmoji => a instanceof Api.DocumentAttributeCustomEmoji,
  );

  const attachment: Attachment = { type: 'document' };

  if (stickerAttr || isCustomEmoji) {
    attachment.type = 'sticker';
    const attr = stickerAttr ?? isCustomEmoji;
    if (attr) attachment.emoji = attr.alt;
    if (stickerAttr?.stickerset instanceof Api.InputStickerSetShortName) {
      attachment.stickerSetName = stickerAttr.stickerset.shortName;
    }
    if (videoAttr) attachment.isVideoSticker = true;
    if (doc.mimeType === 'application/x-tgsticker') attachment.isAnimatedSticker = true;
    if (isCustomEmoji) attachment.customEmojiId = String(doc.id.toJSNumber());
  } else if (videoAttr?.roundMessage) {
    attachment.type = 'video_note';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (isAnimated && videoAttr) {
    attachment.type = 'animation';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (videoAttr) {
    attachment.type = 'video';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (audioAttr?.voice) {
    attachment.type = 'voice';
    attachment.duration = audioAttr.duration;
  } else if (audioAttr) {
    attachment.type = 'audio';
    attachment.duration = audioAttr.duration;
  }

  attachment.mimeType = doc.mimeType;
  attachment.fileSize = doc.size.toJSNumber();
  if (filenameAttr) attachment.fileName = filenameAttr.fileName;
  if (spoiler) attachment.hasSpoiler = true;

  return attachment;
};

// --- gramjs public API ---

export const resolveGramjsSender = (message: Api.Message): TelegramUser | undefined => {
  const fromId = message.fromId;
  if (fromId && fromId instanceof Api.PeerUser) {
    const userId = fromId.userId.toJSNumber();
    const sender = message.sender;
    if (sender && sender instanceof Api.User) {
      return {
        id: String(userId),
        firstName: sender.firstName ?? '',
        lastName: sender.lastName,
        username: sender.username,
        isBot: sender.bot ?? false,
        isPremium: sender.premium ?? false,
      };
    }
    return {
      id: String(userId),
      firstName: '',
      isBot: false,
      isPremium: false,
    };
  }
  return undefined;
};

export const fromGramjsMessage = (
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessage => {
  const replyTo = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;

  return {
    messageId: message.id,
    chatId: resolveChatId(message.peerId),
    sender: senderInfo,
    date: message.date,
    editDate: message.editDate,
    text: message.text,
    entities: convertGramjsEntities(message.entities),
    replyToMessageId: replyTo?.replyToMsgId,
    replyToTopId: replyTo?.replyToTopId,
    forwardInfo: convertGramjsForwardInfo(message.fwdFrom),
    mediaGroupId: message.groupedId ? String(message.groupedId) : undefined,
    viaBotId: message.viaBotId ? String(message.viaBotId.toJSNumber()) : undefined,
    attachments: convertGramjsMedia(message.media),
    source: 'userbot',
  };
};

export const fromGramjsEditedMessage = (
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessageEdit => {
  const base = fromGramjsMessage(message, senderInfo);
  return {
    messageId: base.messageId,
    chatId: base.chatId,
    sender: base.sender,
    date: base.date,
    editDate: message.editDate ?? base.date,
    text: base.text,
    entities: base.entities,
    replyToMessageId: base.replyToMessageId,
    attachments: base.attachments,
  };
};

export const fromGramjsDeletedMessage = (
  deletedIds: number[],
  peer?: Api.PeerChannel,
): TelegramMessageDelete => {
  let chatId: string | undefined;
  if (peer) {
    chatId = `-100${peer.channelId.toJSNumber()}`;
  }
  return { messageIds: deletedIds, chatId };
};

// --- grammY conversion ---

const convertGrammyEntities = (
  entities?: GrammyMessage['entities'],
): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(e => ({
    type: e.type,
    offset: e.offset,
    length: e.length,
    url: 'url' in e ? e.url : undefined,
    language: 'language' in e ? e.language : undefined,
    customEmojiId: 'custom_emoji_id' in e ? e.custom_emoji_id : undefined,
    userId: 'user' in e ? String(e.user.id) : undefined,
  }));
};

const convertGrammyForwardInfo = (
  origin?: GrammyMessage['forward_origin'],
): ForwardInfo | undefined => {
  if (!origin) return undefined;

  const info: ForwardInfo = { date: origin.date };

  switch (origin.type) {
  case 'user':
    info.fromUserId = String(origin.sender_user.id);
    break;
  case 'hidden_user':
    info.senderName = origin.sender_user_name;
    break;
  case 'chat':
    info.fromChatId = String(origin.sender_chat.id);
    break;
  case 'channel':
    info.fromChatId = String(origin.chat.id);
    if (origin.message_id) info.fromMessageId = origin.message_id;
    break;
  }

  return info;
};

const convertGrammyAttachments = (msg: GrammyMessage): Attachment[] | undefined => {
  const spoiler = msg.has_media_spoiler;

  if (msg.photo) {
    const largest = msg.photo.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!largest) return undefined;
    return [{
      type: 'photo',
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      width: largest.width,
      height: largest.height,
      fileSize: largest.file_size,
      hasSpoiler: spoiler,
    }];
  }

  if (msg.sticker) {
    return [{
      type: 'sticker',
      fileId: msg.sticker.file_id,
      fileUniqueId: msg.sticker.file_unique_id,
      width: msg.sticker.width,
      height: msg.sticker.height,
      emoji: msg.sticker.emoji,
      stickerSetName: msg.sticker.set_name,
      isAnimatedSticker: msg.sticker.is_animated,
      isVideoSticker: msg.sticker.is_video,
      customEmojiId: msg.sticker.custom_emoji_id,
      fileSize: msg.sticker.file_size,
    }];
  }

  if (msg.animation) {
    return [{
      type: 'animation',
      fileId: msg.animation.file_id,
      fileUniqueId: msg.animation.file_unique_id,
      width: msg.animation.width,
      height: msg.animation.height,
      duration: msg.animation.duration,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      fileSize: msg.animation.file_size,
    }];
  }

  if (msg.video) {
    return [{
      type: 'video',
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
      width: msg.video.width,
      height: msg.video.height,
      duration: msg.video.duration,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      fileSize: msg.video.file_size,
      hasSpoiler: spoiler,
    }];
  }

  if (msg.video_note) {
    return [{
      type: 'video_note',
      fileId: msg.video_note.file_id,
      fileUniqueId: msg.video_note.file_unique_id,
      width: msg.video_note.length,
      height: msg.video_note.length,
      duration: msg.video_note.duration,
      fileSize: msg.video_note.file_size,
    }];
  }

  if (msg.voice) {
    return [{
      type: 'voice',
      fileId: msg.voice.file_id,
      fileUniqueId: msg.voice.file_unique_id,
      duration: msg.voice.duration,
      mimeType: msg.voice.mime_type,
      fileSize: msg.voice.file_size,
    }];
  }

  if (msg.audio) {
    return [{
      type: 'audio',
      fileId: msg.audio.file_id,
      fileUniqueId: msg.audio.file_unique_id,
      duration: msg.audio.duration,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      fileSize: msg.audio.file_size,
    }];
  }

  if (msg.document) {
    return [{
      type: 'document',
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    }];
  }

  return undefined;
};

export const fromGrammyMessage = (message: GrammyMessage): TelegramMessage => {
  const sender: TelegramUser | undefined = message.from
    ? {
        id: String(message.from.id),
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username,
        isBot: message.from.is_bot,
        isPremium: message.from.is_premium ?? false,
      }
    : undefined;

  const textEntities = message.entities ?? message.caption_entities;
  const textContent = message.text ?? message.caption ?? '';

  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    sender,
    date: message.date,
    editDate: message.edit_date,
    text: textContent,
    entities: convertGrammyEntities(textEntities),
    replyToMessageId: message.reply_to_message?.message_id,
    forwardInfo: convertGrammyForwardInfo(message.forward_origin),
    mediaGroupId: message.media_group_id,
    viaBotId: message.via_bot ? String(message.via_bot.id) : undefined,
    attachments: convertGrammyAttachments(message),
    source: 'bot',
  };
};

// --- dedup ---

export const createMessageDedup = (maxSize = 10000) => {
  const seen = new Set<string>();
  const queue: string[] = [];

  return {
    tryAdd(chatId: string, messageId: number): boolean {
      const key = `${chatId}:${messageId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      queue.push(key);
      while (queue.length > maxSize) {
        const old = queue.shift()!;
        seen.delete(old);
      }
      return true;
    },
  };
};
