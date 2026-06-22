import { contentToPlainText } from '../adaptation';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent, ContentNode } from '../adaptation/types';
import { createBackgroundTaskManager } from '../background-task';
import { isConfiguredChat, selectStartupReplayChatIds, selectTelegramIngressChatIds } from './chat-selection';
import { createPlatformRegistry } from './platform-registry';
import { shellTaskFactory } from '../background-task/shell';
import { getChatIds, loadConfig, resolveBackgroundTasks, resolveChatConfig, resolveModel, resolveRuntime } from '../config/config';
import { useLogger } from '../config/logger';
import { loadContacts } from '../contacts';
import { createDatabase, loadCompaction, loadEvents, loadEventsWithId, loadImageAltTextByHash, loadKnownChatIds, loadLastProbeTime, loadLatestMessageContent, loadMessageAttachments, loadMessageFileId, loadMessageReactionSnapshot, loadTurnResponses, lookupChatId, markStaleSubagentsFailed, migrateV1ToV2, persistCompaction, persistEvent, persistImageAltText, persistMessage, persistMessageDelete, persistMessageEdit, persistProbeResponse, persistTurnResponse, runMigrations, updateEventAttachments, upsertMessageReactionSnapshot } from '../db';
import { getLastMessageId } from '../db/persistence';
import { createDriver } from '../driver';
import { startOneBot } from '../onebot/startup';
import { createPipeline } from '../pipeline';
import type { PipelineEvent } from '../pipeline';
import type { RenderParams } from '../rendering';
import { createAnimationToTextResolver } from '../telegram/animation-to-text';
import { emojiCacheKey } from '../telegram/custom-emoji-to-text';
import { computeThumbnailHash, createImageToTextResolver } from '../telegram/image-to-text';
import type { ImageToTextCompressionConfig } from '../telegram/image-to-text';
import { createSemaphore } from '../telegram/llm-description';
import { normalizeStickerSetMetadata } from '../telegram/pack-title';
import { createTelegramCustomEmojiResolver, startTelegram } from '../telegram/startup';

const logger = useLogger('edelweiss');

export const startApp = async () => {
  const config = loadConfig();
  const runtimeConfig = resolveRuntime(config);
  const backgroundTasksConfig = resolveBackgroundTasks(config);

  const chatIds = getChatIds(config);
  const configuredChatIds = new Set(chatIds);

  // Validate runtime config
  if (runtimeConfig.shell.length === 0)
    throw new Error('runtime.shell must be configured');
  if (!runtimeConfig.writeFile || runtimeConfig.writeFile.length === 0)
    throw new Error('runtime.writeFile must be configured');
  if (!runtimeConfig.readFile || runtimeConfig.readFile.length === 0)
    throw new Error('runtime.readFile must be configured');

  // Compute per-chat image-to-text enablement
  const imageToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled),
  );

  // Use default chat config's imageToText model for the shared resolver
  const defaultChatConfig = resolveChatConfig(config, 'default');
  if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
    throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

  // Compute per-chat animation-to-text enablement
  const animationToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).animationToText.enabled),
  );
  if (animationToTextChatIds.size > 0 && !defaultChatConfig.animationToText.model)
    throw new Error('animationToText.model is required when animationToText.enabled=true (in chats.default or per-chat override)');

  // Compute per-chat custom-emoji-to-text enablement
  const customEmojiToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).customEmojiToText.enabled),
  );
  if (customEmojiToTextChatIds.size > 0 && !defaultChatConfig.customEmojiToText.model)
    throw new Error('customEmojiToText.model is required when customEmojiToText.enabled=true (in chats.default or per-chat override)');

  const blockedUserIdsByChat = new Map(
    chatIds.map(id => [id, new Set(resolveChatConfig(config, id).blockedUserIds)] as const),
  );
  const isBlocked = (chatId: string, senderId: string | undefined): boolean => {
    if (!senderId) return false;
    return blockedUserIdsByChat.get(chatId)?.has(senderId) ?? false;
  };
  const toBlockedMessageEvent = (event: CanonicalMessageEvent): CanonicalBlockedMessageEvent => ({
    type: 'blocked_message',
    chatId: event.chatId,
    messageId: event.messageId,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
  });
  const redactBlockedMessage = (event: CanonicalMessageEvent): CanonicalMessageEvent | CanonicalBlockedMessageEvent =>
    isBlocked(event.chatId, event.sender?.id) ? toBlockedMessageEvent(event) : event;

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);
  await migrateV1ToV2(db, logger);
  markStaleSubagentsFailed(db);

  // Build a semaphore per description model key so resolvers sharing the same endpoint
  // share the same concurrency limit. If the model sets parallel=false, enforce serial execution.
  const descriptionSemaphores = new Map<string, ReturnType<typeof createSemaphore>>();
  const getDescriptionSemaphore = (modelKey: string | undefined): ReturnType<typeof createSemaphore> | undefined => {
    if (!modelKey) return undefined;
    let sem = descriptionSemaphores.get(modelKey);
    if (!sem) {
      const endpoint = resolveModel(config, modelKey);
      sem = createSemaphore(endpoint.descriptionConcurrency ?? 3);
      descriptionSemaphores.set(modelKey, sem);
    }
    return sem;
  };

  // Image-to-text resolver — shared between cold-start replay and live ingress.
  // Compression settings are per-chat; passed at resolve time, not at factory time.
  const imageToTextResolver = createImageToTextResolver({
    enabled: imageToTextChatIds.size > 0,
    model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
    semaphore: getDescriptionSemaphore(defaultChatConfig.imageToText.model),
    logger,
    lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
    persist: record => persistImageAltText(db, record),
  });

  const getImageToTextCompression = (chatId: string): ImageToTextCompressionConfig => {
    const cfg = resolveChatConfig(config, chatId).imageToText;
    return { compress: cfg.compress, pixelBudget: cfg.pixelBudget };
  };

  // Animation-to-text resolver — same pattern, for GIF/animated sticker descriptions.
  const animationToTextResolver = createAnimationToTextResolver({
    enabled: animationToTextChatIds.size > 0,
    model: defaultChatConfig.animationToText.model ? resolveModel(config, defaultChatConfig.animationToText.model) : undefined,
    semaphore: getDescriptionSemaphore(defaultChatConfig.animationToText.model),
    logger,
    lookupByHash: hash => loadImageAltTextByHash(db, hash),
    persist: record => persistImageAltText(db, record),
  });

  // Custom-emoji-to-text resolver — resolves custom emoji sticker images/animations to descriptions.
  // Bot API functions are bound lazily via closure over `ref` (telegram manager is created after resolver).
  const ref: { telegram?: NonNullable<ReturnType<typeof startTelegram>>['manager'] } = {};
  const customEmojiToTextResolver = createTelegramCustomEmojiResolver({
    enabled: customEmojiToTextChatIds.size > 0,
    model: defaultChatConfig.customEmojiToText.model ? resolveModel(config, defaultChatConfig.customEmojiToText.model) : undefined,
    semaphore: getDescriptionSemaphore(defaultChatConfig.customEmojiToText.model),
    maxFrames: defaultChatConfig.customEmojiToText.maxFrames,
    logger,
    lookupByHash: hash => loadImageAltTextByHash(db, hash),
    persist: record => persistImageAltText(db, record),
    managerRef: ref,
  });

  // Sync hydration: after persistEvent, set altText transiently on canonical
  // attachments and custom_emoji content nodes from the image_alt_texts table.
  // This is a sync DB lookup (better-sqlite3) — never stored back into events.
  const walkCustomEmoji = (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => {
    for (const n of nodes) {
      if (n.type === 'custom_emoji') fn(n);
      if ('children' in n) walkCustomEmoji(n.children, fn);
    }
  };

  const hasTelegram = config.telegram != null;
  const knownChatIds = loadKnownChatIds(db);
  const telegramChatIds = chatIds.filter(id => resolveChatConfig(config, id).platform === 'telegram');
  const telegramIngressChatIds = selectTelegramIngressChatIds(knownChatIds, telegramChatIds);

  const hydrateAltTextFromCache = (event: PipelineEvent) => {
    if (event.type !== 'message' && event.type !== 'edit') return;
    for (const att of event.attachments) {
      if (att.altText) continue;
      if (att.thumbnailWebp && imageToTextChatIds.size > 0) {
        const cached = loadImageAltTextByHash(db, computeThumbnailHash(att.thumbnailWebp));
        if (cached) { att.altText = cached.altText; continue; }
      }
      if (att.animationHash && animationToTextChatIds.size > 0) {
        const cached = loadImageAltTextByHash(db, att.animationHash);
        if (cached) {
          att.altText = cached.altText;
          if (cached.stickerSetName) att.stickerSetName = cached.stickerSetName;
        }
      }
    }
    // Hydrate custom_emoji altText + stickerSetName from cache
    if (customEmojiToTextChatIds.size > 0) {
      walkCustomEmoji(event.content, node => {
        if (node.altText) return;
        const cached = loadImageAltTextByHash(db, emojiCacheKey(node.customEmojiId));
        if (cached) {
          node.altText = cached.altText;
          if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
        } else {
          const error = customEmojiToTextResolver.getError(node.customEmojiId);
          if (error) node.altTextError = error;
        }
      });
    }
  };

  // Bot user ID from token — available immediately, used for myself detection.
  // When both platforms are configured, Telegram's botUserId is used for myself detection.
  // OneBot's self_id is only known after the first WS lifecycle event; until then,
  // myself detection for OneBot chats will not trigger.
  const botUserId = hasTelegram ? config.telegram!.botToken.split(':')[0]! : '0';
  const contactNames = loadContacts(logger);
  const renderParams: RenderParams = { botUserId, contactNames };

  const pipeline = createPipeline(renderParams);

  const driverRef: {
    handleEvent?: (chatId: string, rc: import('../rendering/types').RenderedContext) => void;
    handleTyping?: (chatId: string, userId: string) => void;
    setOfflineMode?: (chatId: string, offline: boolean) => void;
    sendMessage?: (chatId: string, text: string) => Promise<void>;
  } = {};

  const telegram = startTelegram({
    config,
    runtimeConfig,
    logger,
    botUserId,
    configuredChatIds,
    telegramIngressChatIds,
    resolveChatId: messageIds => lookupChatId(db, messageIds),
    imageToTextChatIds,
    imageToTextResolver,
    animationToTextChatIds,
    animationToTextResolver,
    customEmojiToTextChatIds,
    customEmojiToTextResolver,
    customEmojiMaxFrames: defaultChatConfig.customEmojiToText.maxFrames,
    animationMaxFrames: defaultChatConfig.animationToText.maxFrames,
    getImageToTextCompression,
    resolveChatPlatform: id => resolveChatConfig(config, id).platform,
    isBlocked,
    toBlockedMessageEvent,
    blockedSenderIdsForChat: chatId => blockedUserIdsByChat.get(chatId),
    hydrateAltTextFromCache: event => hydrateAltTextFromCache(event),
    walkCustomEmoji: (nodes, fn) => walkCustomEmoji(nodes, fn),
    persistEvent: event => persistEvent(db, event),
    pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
    replayChat: (chatId, events) => pipeline.replayChat(chatId, events),
    getIntermediateContext: chatId => pipeline.getIC(chatId),
    onDriverEvent: (chatId, rc) => driverRef.handleEvent?.(chatId, rc),
    handleTyping: (chatId, userId) => driverRef.handleTyping?.(chatId, userId),
    setOfflineMode: (chatId, offline) => driverRef.setOfflineMode?.(chatId, offline),
    loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadEvents: (chatId, afterMs) => loadEvents(db, chatId, afterMs),
    loadEventsWithId: (chatId, afterMs) => loadEventsWithId(db, chatId, afterMs),
    loadLatestMessageContent: (chatId, messageId) => loadLatestMessageContent(db, chatId, messageId),
    loadMessageFileId: (chatId, messageId) => loadMessageFileId(db, chatId, messageId),
    loadMessageReactionSnapshot: (chatId, messageId) => loadMessageReactionSnapshot(db, chatId, messageId),
    persistMessage: msg => persistMessage(db, msg),
    persistMessageEdit: edit => persistMessageEdit(db, edit),
    persistMessageDelete: del => persistMessageDelete(db, del),
    updateEventAttachments: (eventId, attachments) => updateEventAttachments(db, eventId, attachments),
    upsertMessageReactionSnapshot: (chatId, messageId, entries, updatedAtMs) => upsertMessageReactionSnapshot(db, chatId, messageId, entries, updatedAtMs),
  });
  ref.telegram = telegram?.manager;

  // Cold-start: replay events per chat to rebuild IC + RC.
  // If a compaction cursor exists, only load events from that point onward —
  // older events are summarised and no longer needed for IC or rendering.
  const replayChatIds = selectStartupReplayChatIds(knownChatIds, chatIds);
  logger.withFields({
    knownSessions: knownChatIds.length,
    telegramIngressSessions: telegramIngressChatIds.length,
    replaySessions: replayChatIds.length,
  }).log('Startup chat selection');

  for (const chatId of replayChatIds) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    const eventsWithId = loadEventsWithId(db, chatId, compaction?.newCursorMs);
    const blockedSenderIds = blockedUserIdsByChat.get(chatId);
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
    if (hasTelegram) {
      const packTitleTasks: Promise<void>[] = [];
      for (const { id: eventId, event } of filteredEventsWithId) {
        if ((event.type !== 'message' && event.type !== 'edit') || event.attachments.length === 0) continue;
        packTitleTasks.push((async () => {
          if (await normalizeStickerSetMetadata(event.attachments, telegram!.manager.resolvePackTitle))
            updateEventAttachments(db, eventId, event.attachments);
        })());
      }
      if (packTitleTasks.length > 0) await Promise.all(packTitleTasks);
    }

    if (imageToTextChatIds.has(chatId)) {
      const tasks: Promise<void>[] = [];
      for (const event of events) {
        if ((event.type === 'message' || event.type === 'edit') && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          tasks.push(imageToTextResolver.hydrateCanonicalAttachments(event.attachments, caption, getImageToTextCompression(chatId)));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
    }
    // Sync-hydrate: set altText transiently from cache (covers both image and animation)
    for (const event of events) hydrateAltTextFromCache(event);
    pipeline.replayChat(chatId, events);
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

  // Background task manager — created before driver, wired via lazy ref.
  const backgroundTaskManager = createBackgroundTaskManager({
    db,
    persistEvent: event => persistEvent(db, event),
    pushPipelineEvent: (chatId, event) => isConfiguredChat(configuredChatIds, chatId) ? pipeline.pushEvent(chatId, event) : [],
    handleDriverEvent: (chatId, rc) => driverRef.handleEvent?.(chatId, rc),
    taskOutputDir: backgroundTasksConfig.outputDir,
    retentionCount: backgroundTasksConfig.retentionCount,
    logger,
  });
  backgroundTaskManager.registerFactory(shellTaskFactory);

  // Recover incomplete background tasks from DB (tasks paused during last shutdown
  // or left incomplete after a crash). Non-resumable tasks (like shell_execute)
  // immediately complete with a failure message, generating a RuntimeEvent.
  backgroundTaskManager.recoverTasks();

  // --- OneBot setup ---

  const platformRegistry = createPlatformRegistry();
  const oneBot = await startOneBot({
    config: config.onebot,
    chatIds,
    runtimeConfig,
    logger,
    resolveChatPlatform: id => resolveChatConfig(config, id).platform,
    isBlocked,
    toBlockedMessageEvent,
    redactBlockedMessage,
    imageToTextChatIds,
    imageToTextResolver,
    animationToTextResolver,
    getImageToTextCompression,
    persistEvent: event => persistEvent(db, event),
    hydrateAltTextFromCache,
    pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
    replayChat: (chatId, events) => pipeline.replayChat(chatId, events),
    getRenderedContext: chatId => pipeline.getRC(chatId),
    onDriverEvent: (chatId, rc) => driverRef.handleEvent?.(chatId, rc),
    setOfflineMode: (chatId, offline) => driverRef.setOfflineMode?.(chatId, offline),
    sendPlatformMessage: async (chatId, text) => {
      const adapter = platformRegistry.getAdapter(chatId) ?? oneBot?.getAdapter(chatId);
      if (adapter) await adapter.sendMessage(chatId, text);
    },
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadEvents: (chatId, afterMs) => loadEvents(db, chatId, afterMs),
    getLastMessageId: chatId => getLastMessageId(db, chatId),
    registerAdapter: (chatId, adapter) => platformRegistry.setAdapter(chatId, adapter),
  });

  // --- Driver ---

  const driver = createDriver({
    chatIds,
    resolveChatConfig: id => resolveChatConfig(config, id),
  }, {
    loadTurnResponses: (chatId, afterMs, agentId) => loadTurnResponses(db, chatId, afterMs, agentId),
    persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, tr),
    persistProbeResponse: (chatId, probe) => persistProbeResponse(db, chatId, probe),
    sendMessage: telegram
      ? (chatId, text, replyToMessageId, attachments) => telegram.driverHooks.sendMessage(chatId, text, replyToMessageId, attachments)
      : async () => { throw new Error('send_message not available: no Telegram configured'); },
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadLastProbeTime: chatId => loadLastProbeTime(db, chatId),
    persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
    setCompactCursor: (chatId, cursorMs) => pipeline.setCompactCursor(chatId, cursorMs),
    runtimeConfig,
    loadMessageAttachments: telegram
      ? (chatId, messageId) => telegram.driverHooks.loadMessageAttachments(chatId, messageId)
      : () => undefined,
    downloadFile: telegram
      ? fileId => telegram.driverHooks.downloadFile(fileId)
      : async () => { throw new Error('download_file not supported without Telegram'); },
    downloadMessageMedia: telegram?.driverHooks.downloadMessageMedia,
    refreshAllowedReactionEmojis: telegram?.driverHooks.refreshAllowedReactionEmojis,
    getAllowedReactionEmojis: telegram?.driverHooks.getAllowedReactionEmojis,
    sendReaction: telegram
      ? (chatId, messageId, emoji) => telegram.driverHooks.sendReaction(chatId, messageId, emoji)
      : undefined,
    getPlatformAdapter: chatId => {
      const existing = platformRegistry.getAdapter(chatId);
      if (existing) return existing;
      return resolveChatConfig(config, chatId).platform === 'onebot'
        ? oneBot?.getAdapter(chatId)
        : undefined;
    },
    onDebounceStateChange: telegram
      ? (chatId, isDebouncing) => telegram.driverHooks.onDebounceStateChange(chatId, isDebouncing)
      : undefined,
    resolveModel: name => resolveModel(config, name),
    backgroundTask: {
      startTask: (typeName, sessionId, params, intention, timeoutMs) =>
        backgroundTaskManager.startTask(typeName, sessionId, params, intention, timeoutMs),
      killTask: taskId => backgroundTaskManager.killTask(taskId, 'tool_call'),
      getActiveTasks: sessionId => backgroundTaskManager.getActiveTasks(sessionId),
      readTaskOutput: (taskId, offset, limit) => backgroundTaskManager.readTaskOutput(taskId, offset, limit),
    },
    logger,
  });

  // Wire lazy driver ref for background task completion notifications
  driverRef.handleEvent = driver.handleEvent;
  driverRef.handleTyping = driver.handleTyping;
  driverRef.setOfflineMode = driver.setOfflineMode;
  driverRef.sendMessage = async (chatId, text) => {
    const platform = platformRegistry.getAdapter(chatId) ?? oneBot?.getAdapter(chatId);
    if (platform) await platform.sendMessage(chatId, text);
  };

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
      if (oneBot) await oneBot.stop();
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
