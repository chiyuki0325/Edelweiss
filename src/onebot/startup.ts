import type { Logger } from '@guiiai/logg';

import { contentToPlainText } from '../adaptation';
import { resolveOneBotImageAltText } from './image-to-text';
import { adaptOneBotMessage, createOneBotPlatformAdapter, createOneBotServer } from './index';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent } from '../adaptation/types';
import type { RuntimeConfig } from '../config/config';
import type { loadCompaction, loadEvents, persistEvent } from '../db';
import type { getLastMessageId } from '../db/persistence';
import type { PlatformAdapter } from '../driver/types';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import type { AnimationToTextResolver } from '../telegram/animation-to-text';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../telegram/image-to-text';

export interface OneBotStartupDeps {
  config: Parameters<typeof createOneBotServer>[0] | undefined;
  chatIds: string[];
  runtimeConfig: RuntimeConfig;
  logger: Logger;
  resolveChatPlatform: (chatId: string) => string;
  isBlocked: (chatId: string, senderId: string | undefined) => boolean;
  toBlockedMessageEvent: (event: CanonicalMessageEvent) => CanonicalBlockedMessageEvent;
  redactBlockedMessage: (event: CanonicalMessageEvent) => CanonicalMessageEvent | CanonicalBlockedMessageEvent;
  imageToTextChatIds: ReadonlySet<string>;
  imageToTextResolver: ImageToTextResolver;
  animationToTextResolver: AnimationToTextResolver;
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
  persistEvent: typeof persistEvent extends (db: infer _DB, ...args: infer Args) => infer Ret ? (...args: Args) => Ret : never;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext;
  replayChat: (chatId: string, events: PipelineEvent[]) => RenderedContext;
  getRenderedContext: (chatId: string) => RenderedContext | undefined;
  onDriverEvent: (chatId: string, rc: RenderedContext) => void;
  setOfflineMode: (chatId: string, offline: boolean) => void;
  sendPlatformMessage: (chatId: string, text: string) => Promise<void>;
  loadCompaction: (chatId: string) => ReturnType<typeof loadCompaction>;
  loadEvents: (chatId: string, afterMs?: number) => ReturnType<typeof loadEvents>;
  getLastMessageId: typeof getLastMessageId extends (db: infer _DB, ...args: infer Args) => infer Ret ? (...args: Args) => Ret : never;
  registerAdapter: (chatId: string, adapter: PlatformAdapter) => void;
}

export interface OneBotStartupHandle {
  stop(): Promise<void>;
  getAdapter(chatId: string): PlatformAdapter | undefined;
}

export const startOneBot = async (deps: OneBotStartupDeps): Promise<OneBotStartupHandle | undefined> => {
  const onebotConfig = deps.config;
  if (!onebotConfig?.enabled) return undefined;

  const onebotChatIds = deps.chatIds.filter(id => deps.resolveChatPlatform(id) === 'onebot');
  const adapters = new Map<string, PlatformAdapter>();

  const server = createOneBotServer(onebotConfig, {
    onEvent: (chatId, event) => {
      void (async () => {
        try {
          if (!onebotChatIds.includes(chatId)) return;

          if (event.type === 'message' && deps.isBlocked(chatId, event.sender?.id)) {
            const blockedEvent = deps.toBlockedMessageEvent(event);
            deps.logger.withFields({ chatId, messageId: event.messageId }).debug('Redacted OneBot message from blocked user');
            deps.persistEvent(blockedEvent);
            const rc = deps.pushPipelineEvent(chatId, blockedEvent);
            deps.onDriverEvent(chatId, rc);
            return;
          }

          if (event.type === 'message') {
            const text = contentToPlainText(event.content).trim();
            if (text === '/offline' || text === '/online') {
              const off = text === '/offline';
              deps.setOfflineMode(chatId, off);
              const reply = off
                ? 'Offline mode enabled. I will only respond when @mentioned or replied to, then automatically return online.'
                : 'Online mode enabled.';
              await deps.sendPlatformMessage(chatId, reply);
              return;
            }

            if (deps.imageToTextChatIds.has(chatId) && event.attachments.length > 0 && server.api) {
              const caption = contentToPlainText(event.content);
              const compression = deps.getImageToTextCompression(chatId);
              await Promise.all(event.attachments.map(att =>
                resolveOneBotImageAltText(att, caption, server.api!, deps.imageToTextResolver, deps.animationToTextResolver, compression)));
            }
          }

          deps.persistEvent(event);
          deps.hydrateAltTextFromCache(event);
          const rc = deps.pushPipelineEvent(chatId, event);
          deps.onDriverEvent(chatId, rc);
        } catch (err) {
          deps.logger.withError(err).error('OneBot event processing failed');
        }
      })();
    },
    log: deps.logger.withContext('onebot'),
  });

  await server.start();

  deps.logger.log('Waiting for OneBot WS client to connect...');
  while (!server.api) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const getAdapter = (chatId: string): PlatformAdapter | undefined => {
    if (!server.api) return undefined;
    const existing = adapters.get(chatId);
    if (existing) return existing;
    const adapter = createOneBotPlatformAdapter(server.api, deps.runtimeConfig, deps.logger);
    adapters.set(chatId, adapter);
    deps.registerAdapter(chatId, adapter);
    return adapter;
  };

  const onebotGroupChats = onebotChatIds.filter(id => !id.startsWith('private:'));
  for (const chatId of onebotGroupChats) {
    const pulledMessages = [];
    let lastMessageId = deps.getLastMessageId(chatId);

    while (true) {
      try {
        const messages = await server.api!.fetchMessages(chatId, lastMessageId ?? undefined);
        if (messages.length <= 1) break;
        pulledMessages.push(...messages.slice(1));
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1]!;
          lastMessageId = String(lastMessage.message_id);
          deps.logger.withFields({ chatId, pulled: messages.length - 1 }).log('Pulled messages from OneBot');
        }
      } catch (err) {
        deps.logger.withError(err).error(`Failed to fetch messages for chat ${chatId}`);
        break;
      }
    }

    if (pulledMessages.length === 0) continue;

    const events = (await Promise.all(pulledMessages.map(msg => adaptOneBotMessage(server.api!, msg))))
      .map(deps.redactBlockedMessage);

    if (deps.imageToTextChatIds.has(chatId) && server.api) {
      for (const event of events) {
        if (event.type === 'message' && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          const compression = deps.getImageToTextCompression(chatId);
          await Promise.all(event.attachments.map(att =>
            resolveOneBotImageAltText(att, caption, server.api!, deps.imageToTextResolver, deps.animationToTextResolver, compression)));
        }
      }
    }

    for (const event of events) {
      deps.persistEvent(event);
      deps.hydrateAltTextFromCache(event);
    }

    const compaction = deps.loadCompaction(chatId);
    const allEvents = deps.loadEvents(chatId, compaction?.newCursorMs);
    deps.replayChat(chatId, allEvents);

    const rc = deps.getRenderedContext(chatId);
    deps.logger.withFields({ chatId, events: events.length }).log('Replayed pulled messages into pipeline');

    if (rc) deps.onDriverEvent(chatId, rc);
  }

  return {
    stop: () => server.stop(),
    getAdapter,
  };
};
