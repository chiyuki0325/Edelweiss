import { execFile } from 'node:child_process';

import type { Logger } from '@guiiai/logg';

import { adaptMessage } from './adaption';
import type { SentMessage as TelegramSentMessage } from './bot';
import type { TelegramEventSink } from './event-sink';
import type { TelegramManager } from './manager';
import { renderMarkdownToTelegramHTML } from './markdown';
import type { Attachment } from './message/types';
import type { TelegramReactionStore } from './stores';
import type { RuntimeConfig } from '../config/config';

export interface TelegramDriverHooks {
  sendMessage(chatId: string, text: string, replyToMessageId?: number, attachments?: {
    type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
    path: string;
    file_name?: string;
  }[]): Promise<TelegramSentMessage>;
  loadMessageAttachments(chatId: string, messageId: number): Attachment[] | undefined;
  downloadFile(fileId: string): Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  refreshAllowedReactionEmojis?: (chatId: string, signal?: AbortSignal) => Promise<string[]>;
  getAllowedReactionEmojis?: (chatId: string) => string[];
  sendReaction(chatId: string, messageId: number, emoji: string): Promise<void>;
  onDebounceStateChange(chatId: string, isDebouncing: boolean): void;
}

export interface TelegramDriverHooksDeps {
  manager: TelegramManager;
  runtimeConfig: RuntimeConfig;
  logger: Logger;
  botUserId: string;
  eventSink: TelegramEventSink;
  reactionStore: TelegramReactionStore;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  getIntermediateContext: (chatId: string) => { nodes: Array<{ type: string; messageId?: string }> } | undefined;
  resolveChatPlatform: (chatId: string) => string;
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

export const createTelegramDriverHooks = (deps: TelegramDriverHooksDeps): TelegramDriverHooks => {
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
    case 'photo': return await deps.manager.sendPhoto(chatId, buffer, opts);
    case 'video': return await deps.manager.sendVideo(chatId, buffer, opts);
    case 'audio': return await deps.manager.sendAudio(chatId, buffer, opts);
    case 'voice': return await deps.manager.sendVoice(chatId, buffer, opts);
    case 'animation': return await deps.manager.sendAnimation(chatId, buffer, opts);
    case 'video_note': return await deps.manager.sendVideoNote(chatId, buffer, opts);
    case 'document':
    default: return await deps.manager.sendDocument(chatId, buffer, { ...opts, fileName });
    }
  };

  const injectSyntheticEvent = (
    chatId: string,
    sent: { messageId: number; date: number; text: string; entities?: import('./message/types').MessageEntity[] },
    replyToMessageId?: number,
  ) => {
    const botInfo = deps.manager.bot.botInfo();
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
    const event = adaptMessage(syntheticMsg, deps.botUserId);
    event.isSelfSent = true;

    const ic = deps.getIntermediateContext(chatId);
    if (ic?.nodes.some(n => n.type === 'message' && n.messageId === event.messageId))
      deps.logger.withFields({ chatId, messageId: event.messageId }).warn('Synthetic bypass: userbot arrived first (isSelfSent merged via dedup)');

    deps.eventSink.persist(event);
    deps.reactionStore.upsertSnapshot(chatId, event.messageId, [], event.receivedAtMs);
    deps.eventSink.publish(event, { hydrateAltText: true });
  };

  const sendMessage: TelegramDriverHooks['sendMessage'] = async (chatId, text, replyToMessageId, attachments) => {
    if (!attachments || attachments.length === 0) {
      const sent = await deps.manager.sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : undefined);
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

    const sentMessages = await deps.manager.sendMediaGroup(chatId, media, replyToMessageId ? { replyToMessageId } : undefined);
    for (const sent of sentMessages)
      injectSyntheticEvent(chatId, sent, replyToMessageId);
    return sentMessages[0]!;
  };

  return {
    sendMessage,
    loadMessageAttachments: deps.loadMessageAttachments,
    downloadFile: fileId => deps.manager.bot.downloadFile(fileId),
    downloadMessageMedia: deps.manager.userbot
      ? (chatId, messageId) => deps.manager.userbot!.downloadMessageMedia(chatId, messageId)
      : undefined,
    refreshAllowedReactionEmojis: deps.manager.userbot
      ? (chatId, signal) => deps.manager.refreshAllowedReactionEmojis(chatId, signal)
      : undefined,
    getAllowedReactionEmojis: deps.manager.userbot
      ? chatId => deps.manager.getAllowedReactionEmojis(chatId)
      : undefined,
    sendReaction: (chatId, messageId, emoji) => deps.manager.sendReaction(chatId, messageId, emoji),
    onDebounceStateChange: (chatId, isDebouncing) => {
      if (deps.resolveChatPlatform(chatId) !== 'telegram') return;
      if (isDebouncing) {
        deps.manager.startTypingPolling(chatId);
      } else {
        deps.manager.stopTypingPolling(chatId);
      }
    },
  };
};
