import { contentToPlainText } from '../adaptation';
import { selectStartupReplayChatIds } from './chat-selection';
import { shellTaskFactory } from '../background-task/shell';
import { getChatIds, resolveChatConfig } from '../config/config';
import { buildContainer } from '../container';
import { TOKENS } from '../container/tokens';
import { loadCompaction, loadEvents, loadEventsWithId, loadKnownChatIds, markStaleSubagentsFailed, migrateV1ToV2, persistEvent, updateEventAttachments } from '../db';
import { getLastMessageId } from '../db/persistence';
import { startOneBot } from '../onebot/startup';
import { normalizeStickerSetMetadata } from '../telegram/pack-title';

export const startApp = async () => {
  const { get } = buildContainer();

  const logger = get(TOKENS.LOGGER);
  const config = get(TOKENS.CONFIG);

  const chatIds = getChatIds(config);

  // DB: createDatabase + sync migrations happen in the factory. Async v2
  // migration and stale-subagent cleanup run here, once, after the DB exists.
  const db = get(TOKENS.DB);
  await migrateV1ToV2(db, logger);
  markStaleSubagentsFailed(db);

  const pipeline = get(TOKENS.PIPELINE);
  const chatPolicy = get(TOKENS.CHAT_POLICY);
  const altText = get(TOKENS.ALT_TEXT_POLICY);
  const feature = get(TOKENS.FEATURE_SETS);
  const imageToTextResolver = get(TOKENS.IMAGE_TO_TEXT_RESOLVER);

  // Construct the Telegram manager before cold-start replay: replay uses the
  // manager's resolvePackTitle for legacy sticker metadata normalization.
  const telegram = get(TOKENS.TELEGRAM);

  // Cold-start: replay events per chat to rebuild IC + RC.
  // If a compaction cursor exists, only load events from that point onward —
  // older events are summarised and no longer needed for IC or rendering.
  const knownChatIds = loadKnownChatIds(db);
  const replayChatIds = selectStartupReplayChatIds(knownChatIds, chatIds);
  logger.withFields({
    knownSessions: knownChatIds.length,
    replaySessions: replayChatIds.length,
  }).log('Startup chat selection');

  for (const chatId of replayChatIds) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    const eventsWithId = loadEventsWithId(db, chatId, compaction?.newCursorMs);
    const blockedSenderIds = chatPolicy.blockedUserIdsByChat.get(chatId);
    const filteredEventsWithId = blockedSenderIds?.size
      ? eventsWithId.filter(({ event }) => {
          if (!('sender' in event) || !event.sender?.id) return true;
          return !blockedSenderIds.has(event.sender.id);
        })
      : eventsWithId;
    const events = filteredEventsWithId.map(({ event }) => event);

    // Legacy events stored raw set_name in stickerSetName. Normalize them once and
    // persist the resolved title so cold-start replay and live ingress share one format.
    // Requires Telegram (resolvePackTitle uses Bot API).
    if (telegram) {
      const packTitleTasks: Promise<void>[] = [];
      for (const { id: eventId, event } of filteredEventsWithId) {
        if ((event.type !== 'message' && event.type !== 'edit') || event.attachments.length === 0) continue;
        packTitleTasks.push((async () => {
          if (await normalizeStickerSetMetadata(event.attachments, telegram.manager.resolvePackTitle))
            updateEventAttachments(db, eventId, event.attachments);
        })());
      }
      if (packTitleTasks.length > 0) await Promise.all(packTitleTasks);
    }

    if (feature.imageToTextChatIds.has(chatId)) {
      const tasks: Promise<void>[] = [];
      for (const event of events) {
        if ((event.type === 'message' || event.type === 'edit') && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          tasks.push(imageToTextResolver.hydrateCanonicalAttachments(event.attachments, caption, altText.getImageToTextCompression(chatId)));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
    }
    // Sync-hydrate: set altText transiently from cache (covers both image and animation)
    for (const event of events) altText.hydrateAltTextFromCache(event);
    pipeline.replayChat(chatId, events);
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

  // Background task manager — recover incomplete tasks from the last shutdown/crash.
  // Non-resumable tasks (like shell_execute) immediately complete with a failure
  // message, generating a RuntimeEvent.
  const backgroundTaskManager = get(TOKENS.BACKGROUND_TASK_MANAGER);
  backgroundTaskManager.registerFactory(shellTaskFactory);
  backgroundTaskManager.recoverTasks();

  // --- OneBot setup (async: awaits a WS client, so it cannot be a sync factory) ---

  const platformRegistry = get(TOKENS.PLATFORM_REGISTRY);
  const oneBotHolder = get(TOKENS.ONEBOT);
  oneBotHolder.handle = await startOneBot({
    config: config.onebot,
    chatIds,
    runtimeConfig: get(TOKENS.RUNTIME_CONFIG),
    logger,
    resolveChatPlatform: id => resolveChatConfig(config, id).platform,
    isBlocked: chatPolicy.isBlocked,
    toBlockedMessageEvent: chatPolicy.toBlockedMessageEvent,
    redactBlockedMessage: chatPolicy.redactBlockedMessage,
    imageToTextChatIds: feature.imageToTextChatIds,
    imageToTextResolver,
    animationToTextResolver: get(TOKENS.ANIMATION_TO_TEXT_RESOLVER),
    getImageToTextCompression: altText.getImageToTextCompression,
    persistEvent: event => persistEvent(db, event),
    hydrateAltTextFromCache: altText.hydrateAltTextFromCache,
    pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
    replayChat: (chatId, events) => pipeline.replayChat(chatId, events),
    getRenderedContext: chatId => pipeline.getRC(chatId),
    onDriverEvent: (chatId, rc) => get(TOKENS.DRIVER).handleEvent(chatId, rc),
    setOfflineMode: (chatId, offline) => get(TOKENS.DRIVER).setOfflineMode(chatId, offline),
    sendPlatformMessage: async (chatId, text) => {
      const adapter = platformRegistry.getAdapter(chatId) ?? oneBotHolder.handle?.getAdapter(chatId);
      if (adapter) await adapter.sendMessage(chatId, text);
    },
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadEvents: (chatId, afterMs) => loadEvents(db, chatId, afterMs),
    getLastMessageId: chatId => getLastMessageId(db, chatId),
    registerAdapter: (chatId, adapter) => platformRegistry.setAdapter(chatId, adapter),
  });

  // --- Driver ---

  const driver = get(TOKENS.DRIVER);
  logger.withFields({ chatIds }).log('Driver initialized');

  // Feed replayed sessions into Driver so it can respond to un-answered messages
  // and trigger compaction check if context exceeds budget (compaction effect fires
  // automatically when conditions are met — no explicit startup trigger needed).
  for (const chatId of pipeline.getChatIds()) {
    const rc = pipeline.getRC(chatId);
    if (rc) driver.handleEvent(chatId, rc);
  }

  await telegram?.startLiveHandlers();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log('Shutting down...');
    backgroundTaskManager.shutdown();
    driver.stop();
    try {
      if (telegram) await telegram.stop();
      if (oneBotHolder.handle) await oneBotHolder.handle.stop();
      process.exit(0);
    } catch (err) {
      logger.withError(err).error('Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  logger.log('Edelweiss is running');

  await telegram?.runPostStartupTasks();
};
