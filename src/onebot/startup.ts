import type { Logger } from '@guiiai/logg';

import { adaptOneBotMessage } from './adaptation';
import { resolveOneBotImageAltText } from './image-to-text';
import { createOneBotPlatformAdapter, createOneBotServer } from './index';
import { createOneBotIngress } from './ingress';
import { createOneBotPostStartupTasks } from './post-startup';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent } from '../adaption-types';
import type { RuntimeConfig } from '../config/config';
import type { loadCompaction, loadEvents, loadEventsWithId, persistEvent, updateEventAttachments } from '../db';
import type { getLastMessageId } from '../db/persistence';
import type { ManualCompactionResult, PlatformAdapter } from '../driver/types';
import { createMessageDedup } from '../ingress/message-dedup';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import { contentToPlainText } from '../telegram/adaption';

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
  requestCompaction: (chatId: string) => Promise<ManualCompactionResult>;
  sendPlatformMessage: (chatId: string, text: string) => Promise<void>;
  loadCompaction: (chatId: string) => ReturnType<typeof loadCompaction>;
  loadEvents: (chatId: string, afterMs?: number) => ReturnType<typeof loadEvents>;
  loadEventsWithId: (chatId: string, afterMs?: number) => ReturnType<typeof loadEventsWithId>;
  updateEventAttachments: (eventId: number, attachments: Parameters<typeof updateEventAttachments>[2]) => void;
  getLastMessageId: typeof getLastMessageId extends (db: infer _DB, ...args: infer Args) => infer Ret ? (...args: Args) => Ret : never;
  registerAdapter: (chatId: string, adapter: PlatformAdapter) => void;
}

export interface OneBotStartupHandle {
  stop(): Promise<void>;
  getAdapter(chatId: string): PlatformAdapter | undefined;
  getChatName(chatId: string): Promise<string>;
  runPostStartupTasks(): Promise<void>;
}

export const startOneBot = async (deps: OneBotStartupDeps): Promise<OneBotStartupHandle | undefined> => {
  const onebotConfig = deps.config;
  if (!onebotConfig?.enabled) return undefined;

  const onebotChatIds = deps.chatIds.filter(id => deps.resolveChatPlatform(id) === 'onebot');
  const adapters = new Map<string, PlatformAdapter>();

  // Single dedup shared between live ingress and the cold-start history pull
  // below. The WS server must be listening (and may already be delivering live
  // events) before get_group_msg_history can run, so any message in that overlap
  // window would otherwise be processed twice — once live, once from history.
  // Deduping across both paths by (chatId, messageId) closes that race without
  // needing to buffer or pause live ingress.
  const dedup = createMessageDedup();

  // The ingress getApi closure and the server's onEvent form a cycle: ingress
  // reads server.api lazily, and the server forwards frames into ingress.enqueue.
  // A holder breaks the cycle without a forward `let` (which prefer-const rejects).
  const serverHolder: { current?: ReturnType<typeof createOneBotServer> } = {};

  const ingress = createOneBotIngress({
    logger: deps.logger,
    getApi: () => serverHolder.current?.api ?? null,
    isWhitelisted: chatId => onebotChatIds.includes(chatId),
    isBlocked: deps.isBlocked,
    toBlockedMessageEvent: deps.toBlockedMessageEvent,
    imageToTextChatIds: deps.imageToTextChatIds,
    imageToTextResolver: deps.imageToTextResolver,
    animationToTextResolver: deps.animationToTextResolver,
    getImageToTextCompression: deps.getImageToTextCompression,
    persistEvent: deps.persistEvent,
    hydrateAltTextFromCache: deps.hydrateAltTextFromCache,
    pushPipelineEvent: deps.pushPipelineEvent,
    onDriverEvent: deps.onDriverEvent,
    setOfflineMode: deps.setOfflineMode,
    requestCompaction: deps.requestCompaction,
    sendPlatformMessage: deps.sendPlatformMessage,
    dedup,
  });

  const server = createOneBotServer(onebotConfig, {
    onEvent: (raw, meta) => ingress.enqueue(raw, meta),
    log: deps.logger.withContext('onebot'),
  });
  serverHolder.current = server;

  await server.start();

  deps.logger.log('Waiting for OneBot WS client to connect...');
  while (!server.api) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const getAdapter = (chatId: string): PlatformAdapter | undefined => {
    const existing = adapters.get(chatId);
    if (existing) return existing;
    const adapter = createOneBotPlatformAdapter({
      getApi: () => server.api,
      runtime: deps.runtimeConfig,
      logger: deps.logger,
      selfSentSink: {
        getSelfId: () => server.selfId,
        persistEvent: deps.persistEvent,
        hydrateAltTextFromCache: deps.hydrateAltTextFromCache,
        pushPipelineEvent: deps.pushPipelineEvent,
      },
    });
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
        // Skip any message the live ingress path already reserved — `tryAdd`
        // returns false for those, so the overlap window is processed once.
        pulledMessages.push(...messages.slice(1).filter(msg => dedup.tryAdd(chatId, msg.message_id)));
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

    const events = (await Promise.all(pulledMessages.map(msg => adaptOneBotMessage(server.api!, msg, {
      // Historical replay: derive the ordering timestamp from the message's
      // server time rather than the wall clock, so replayed events keep their
      // original order relative to one another and to live events.
      receivedAtMs: msg.time * 1000,
      utcOffsetMin: -new Date().getTimezoneOffset(),
    }))))
      .map(deps.redactBlockedMessage);

    if (deps.imageToTextChatIds.has(chatId) && server.api) {
      for (const event of events) {
        if (event.type === 'message' && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          const compression = deps.getImageToTextCompression(chatId);
          // Historical backfill is best-effort, unlike the live ingress path
          // (which is fail-closed with bounded-retry-then-drop). Old QQ media
          // references are often already expired, so a failure here must not
          // abort startup — the event is still persisted and renders with its
          // thumbnail. Live consistency is enforced by the ingress queue.
          try {
            await Promise.all(event.attachments.map(att =>
              resolveOneBotImageAltText(att, caption, server.api!, deps.imageToTextResolver, deps.animationToTextResolver, compression)));
          } catch (err) {
            deps.logger.withError(err).withFields({ chatId, messageId: event.messageId })
              .warn('OneBot replay alt-text resolution failed; keeping event without alt text');
          }
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

  const postStartupTasks = createOneBotPostStartupTasks({
    logger: deps.logger,
    getApi: () => serverHolder.current?.api ?? null,
    imageToTextChatIds: deps.imageToTextChatIds,
    imageToTextResolver: deps.imageToTextResolver,
    animationToTextResolver: deps.animationToTextResolver,
    getImageToTextCompression: deps.getImageToTextCompression,
    resolveChatPlatform: deps.resolveChatPlatform,
    loadCompaction: deps.loadCompaction,
    loadEventsWithId: deps.loadEventsWithId,
    updateEventAttachments: deps.updateEventAttachments,
    hydrateAltTextFromCache: deps.hydrateAltTextFromCache,
    replayChat: deps.replayChat,
    getRenderedContext: deps.getRenderedContext,
    onDriverEvent: deps.onDriverEvent,
  });

  return {
    stop: () => server.stop(),
    getAdapter,
    getChatName: chatId => server.api?.getChatName(chatId) ?? Promise.resolve(chatId),
    runPostStartupTasks: () => postStartupTasks.run(),
  };
};
