import 'reflect-metadata';

import { container as rootContainer } from 'tsyringe';
import type { DependencyContainer } from 'tsyringe';

import { TOKENS } from './tokens';
import type { AltTextPolicy, ChatPolicy, DescriptionSemaphores, FeatureSets, OneBotHolder, Semaphore, Token } from './tokens';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent, ContentNode } from '../adaption-types';
import { createBackgroundTaskManager } from '../background-task/manager';
import { getChatIds, loadConfig, resolveBackgroundTasks, resolveChatConfig, resolveModel, resolveRuntime } from '../config/config';
import { useLogger } from '../config/logger';
import { loadContacts } from '../contacts';
import { createDatabase, loadCompaction, loadEvents, loadEventsWithId, loadImageAltTextByHash, loadKnownChatIds, loadLatestMessageContent, loadMessageAttachments, loadMessageFileId, loadMessageReactionSnapshot, loadTurnResponses, lookupChatId, persistCompaction, persistEvent, persistImageAltText, persistMessage, persistMessageDelete, persistMessageEdit, persistTurnResponse, runMigrations, updateEventAttachments, upsertMessageReactionSnapshot } from '../db';
import { createDriver } from '../driver';
import { createAnimationToTextResolver } from '../media/animation-to-text';
import { emojiCacheKey } from '../media/custom-emoji-to-text';
import { computeThumbnailHash, createImageToTextResolver } from '../media/image-to-text';
import type { ImageToTextCompressionConfig } from '../media/image-to-text';
import { createSemaphore } from '../media/llm-description';
import { createPipeline } from '../pipeline';
import type { PipelineEvent } from '../pipeline';
import type { RenderParams } from '../rendering';
import { isConfiguredChat, selectTelegramIngressChatIds } from '../startup/chat-selection';
import { createPlatformRegistry } from '../startup/platform-registry';
import { createTelegramCustomEmojiResolver, createTelegramDriverHooks, createTelegramEventSink, createTelegramLiveHandlers, createTelegramPostStartupTasks, createTelegramStartupManager, startTelegram } from '../telegram';

const logger = useLogger('edelweiss');

// tsyringe's FactoryProvider never caches, and its built-in instanceCachingFactory
// re-runs whenever a factory returns undefined (it tests `instance == undefined`).
// TELEGRAM legitimately resolves to `undefined`, so we memoize with an explicit
// presence flag to guarantee single construction even for undefined values.
const singleton = <T>(factory: (c: DependencyContainer) => T): ((c: DependencyContainer) => T) => {
  let cached: { value: T } | undefined;
  return c => {
    cached ??= { value: factory(c) };
    return cached.value;
  };
};

// Walk a ContentNode tree and invoke `fn` on every custom_emoji node. Pure helper
// shared by the alt-text hydration policy and Telegram post-startup tasks.
const walkCustomEmoji = (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => {
  for (const n of nodes) {
    if (n.type === 'custom_emoji') fn(n);
    if ('children' in n) walkCustomEmoji(n.children, fn);
  }
};

export interface Container {
  container: DependencyContainer;
  get: <T>(tok: Token<T>) => T;
}

export const buildContainer = (): Container => {
  const c = rootContainer.createChildContainer();
  const get = <T>(tok: Token<T>): T => c.resolve<T>(tok.sym);
  const register = <T>(tok: Token<T>, factory: (c: DependencyContainer) => T) => {
    c.register<T>(tok.sym, { useFactory: singleton(factory) });
  };

  // --- Config + leaf values ---

  register(TOKENS.LOGGER, () => logger);
  register(TOKENS.CONFIG, () => loadConfig());

  register(TOKENS.RUNTIME_CONFIG, () => {
    const runtimeConfig = resolveRuntime(get(TOKENS.CONFIG));
    if (runtimeConfig.shell.length === 0)
      throw new Error('runtime.shell must be configured');
    if (!runtimeConfig.writeFile || runtimeConfig.writeFile.length === 0)
      throw new Error('runtime.writeFile must be configured');
    if (!runtimeConfig.readFile || runtimeConfig.readFile.length === 0)
      throw new Error('runtime.readFile must be configured');
    return runtimeConfig;
  });

  register(TOKENS.BG_TASKS_CONFIG, () => resolveBackgroundTasks(get(TOKENS.CONFIG)));

  // --- Database (sync construction + migrations; async v2 migration runs in the orchestrator) ---

  register(TOKENS.DB, () => {
    const config = get(TOKENS.CONFIG);
    const db = createDatabase(config.database.path, logger);
    runMigrations(db, logger);
    return db;
  });

  // --- Feature enablement sets + model validation ---

  register(TOKENS.FEATURE_SETS, (): FeatureSets => {
    const config = get(TOKENS.CONFIG);
    const chatIds = getChatIds(config);
    const defaultChatConfig = resolveChatConfig(config, 'default');

    const imageToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled));
    if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
      throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

    const animationToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).animationToText.enabled));
    if (animationToTextChatIds.size > 0 && !defaultChatConfig.animationToText.model)
      throw new Error('animationToText.model is required when animationToText.enabled=true (in chats.default or per-chat override)');

    const customEmojiToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).customEmojiToText.enabled));
    if (customEmojiToTextChatIds.size > 0 && !defaultChatConfig.customEmojiToText.model)
      throw new Error('customEmojiToText.model is required when customEmojiToText.enabled=true (in chats.default or per-chat override)');

    return { imageToTextChatIds, animationToTextChatIds, customEmojiToTextChatIds };
  });

  // --- Blocking / redaction policy ---

  register(TOKENS.CHAT_POLICY, (): ChatPolicy => {
    const config = get(TOKENS.CONFIG);
    const chatIds = getChatIds(config);
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
    return { isBlocked, toBlockedMessageEvent, redactBlockedMessage, blockedUserIdsByChat };
  });

  // --- Per-model description-LLM semaphores ---

  register(TOKENS.DESCRIPTION_SEMAPHORES, (): DescriptionSemaphores => {
    const config = get(TOKENS.CONFIG);
    const cache = new Map<string, Semaphore>();
    return {
      get: (modelKey: string | undefined): Semaphore | undefined => {
        if (!modelKey) return undefined;
        let sem = cache.get(modelKey);
        if (!sem) {
          const endpoint = resolveModel(config, modelKey);
          sem = createSemaphore(endpoint.descriptionConcurrency ?? 3);
          cache.set(modelKey, sem);
        }
        return sem;
      },
    };
  });

  // --- Alt-text resolvers ---

  register(TOKENS.IMAGE_TO_TEXT_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    return createImageToTextResolver({
      enabled: get(TOKENS.FEATURE_SETS).imageToTextChatIds.size > 0,
      model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.imageToText.model),
      logger,
      lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
      persist: record => persistImageAltText(db, record),
    });
  });

  register(TOKENS.ANIMATION_TO_TEXT_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    return createAnimationToTextResolver({
      enabled: get(TOKENS.FEATURE_SETS).animationToTextChatIds.size > 0,
      model: defaultChatConfig.animationToText.model ? resolveModel(config, defaultChatConfig.animationToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.animationToText.model),
      logger,
      lookupByHash: hash => loadImageAltTextByHash(db, hash),
      persist: record => persistImageAltText(db, record),
    });
  });

  register(TOKENS.CUSTOM_EMOJI_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    // managerRef is a lazy getter: it resolves TELEGRAM_MANAGER only when invoked at
    // runtime (after startup wiring completes), breaking the resolver↔telegram cycle.
    const managerRef = {
      get telegram() { return get(TOKENS.TELEGRAM_MANAGER); },
    };
    return createTelegramCustomEmojiResolver({
      enabled: get(TOKENS.FEATURE_SETS).customEmojiToTextChatIds.size > 0,
      model: defaultChatConfig.customEmojiToText.model ? resolveModel(config, defaultChatConfig.customEmojiToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.customEmojiToText.model),
      maxFrames: defaultChatConfig.customEmojiToText.maxFrames,
      logger,
      lookupByHash: hash => loadImageAltTextByHash(db, hash),
      persist: record => persistImageAltText(db, record),
      managerRef,
    });
  });

  // --- Alt-text hydration policy ---

  register(TOKENS.ALT_TEXT_POLICY, (): AltTextPolicy => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const { imageToTextChatIds, animationToTextChatIds, customEmojiToTextChatIds } = get(TOKENS.FEATURE_SETS);
    const customEmojiResolver = get(TOKENS.CUSTOM_EMOJI_RESOLVER);

    const getImageToTextCompression = (chatId: string): ImageToTextCompressionConfig => {
      const cfg = resolveChatConfig(config, chatId).imageToText;
      return { compress: cfg.compress, pixelBudget: cfg.pixelBudget };
    };

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
      if (customEmojiToTextChatIds.size > 0) {
        walkCustomEmoji(event.content, node => {
          if (node.altText) return;
          const cached = loadImageAltTextByHash(db, emojiCacheKey(node.customEmojiId));
          if (cached) {
            node.altText = cached.altText;
            if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
          } else {
            const error = customEmojiResolver.getError(node.customEmojiId);
            if (error) node.altTextError = error;
          }
        });
      }
    };

    return { getImageToTextCompression, hydrateAltTextFromCache, walkCustomEmoji };
  });

  // --- Render params + pipeline ---

  register(TOKENS.RENDER_PARAMS, (): RenderParams => {
    const config = get(TOKENS.CONFIG);
    const botUserId = config.telegram != null ? config.telegram.botToken.split(':')[0]! : '0';
    return { botUserId, contactNames: loadContacts(logger) };
  });

  register(TOKENS.PIPELINE, () => createPipeline(get(TOKENS.RENDER_PARAMS)));

  register(TOKENS.PLATFORM_REGISTRY, () => createPlatformRegistry());

  // OneBot handle holder — populated asynchronously by the orchestrator after
  // startOneBot resolves its WS client.
  register(TOKENS.ONEBOT, (): OneBotHolder => ({ handle: undefined }));

  // --- Telegram ---

  register(TOKENS.TELEGRAM_MANAGER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const altText = get(TOKENS.ALT_TEXT_POLICY);
    const feature = get(TOKENS.FEATURE_SETS);
    const defaultChatConfig = resolveChatConfig(config, 'default');

    const chatIds = getChatIds(config);
    const knownChatIds = loadKnownChatIds(db);
    const telegramChatIds = chatIds.filter(id => resolveChatConfig(config, id).platform === 'telegram');
    const telegramIngressChatIds = selectTelegramIngressChatIds(knownChatIds, telegramChatIds);

    return createTelegramStartupManager({
      config,
      logger,
      telegramIngressChatIds,
      resolveChatId: messageIds => lookupChatId(db, messageIds),
      imageToTextChatIds: feature.imageToTextChatIds,
      imageToTextResolver: get(TOKENS.IMAGE_TO_TEXT_RESOLVER),
      animationToTextChatIds: feature.animationToTextChatIds,
      animationToTextResolver: get(TOKENS.ANIMATION_TO_TEXT_RESOLVER),
      customEmojiToTextChatIds: feature.customEmojiToTextChatIds,
      customEmojiToTextResolver: get(TOKENS.CUSTOM_EMOJI_RESOLVER),
      animationMaxFrames: defaultChatConfig.animationToText.maxFrames,
      getImageToTextCompression: altText.getImageToTextCompression,
    });
  });

  register(TOKENS.TELEGRAM_EVENT_SINK, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const altText = get(TOKENS.ALT_TEXT_POLICY);
    return createTelegramEventSink({
      configuredChatIds: new Set(getChatIds(config)),
      persistEvent: event => persistEvent(db, event),
      hydrateAltTextFromCache: event => altText.hydrateAltTextFromCache(event),
      pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
      onDriverEvent: (chatId, rc) => get(TOKENS.DRIVER).handleEvent(chatId, rc),
    });
  });

  register(TOKENS.TELEGRAM_MESSAGE_STORE, () => {
    const db = get(TOKENS.DB);
    return {
      loadLatestMessageContent: (chatId, messageId) => loadLatestMessageContent(db, chatId, messageId),
      persistMessage: msg => persistMessage(db, msg),
      persistMessageEdit: edit => persistMessageEdit(db, edit),
      persistMessageDelete: del => persistMessageDelete(db, del),
    };
  });

  register(TOKENS.TELEGRAM_REACTION_STORE, () => {
    const db = get(TOKENS.DB);
    return {
      loadSnapshot: (chatId, messageId) => loadMessageReactionSnapshot(db, chatId, messageId),
      upsertSnapshot: (chatId, messageId, entries, updatedAtMs) => upsertMessageReactionSnapshot(db, chatId, messageId, entries, updatedAtMs),
    };
  });

  register(TOKENS.TELEGRAM_DRIVER_HOOKS, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) throw new Error('Telegram driver hooks requested without Telegram configured');
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    return createTelegramDriverHooks({
      manager,
      runtimeConfig: get(TOKENS.RUNTIME_CONFIG),
      logger,
      botUserId: get(TOKENS.RENDER_PARAMS).botUserId ?? '0',
      eventSink: get(TOKENS.TELEGRAM_EVENT_SINK),
      reactionStore: get(TOKENS.TELEGRAM_REACTION_STORE),
      loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
      getIntermediateContext: chatId => pipeline.getIC(chatId),
      resolveChatPlatform: id => resolveChatConfig(config, id).platform,
    });
  });

  register(TOKENS.TELEGRAM_LIVE_HANDLERS, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) throw new Error('Telegram live handlers requested without Telegram configured');
    const chatPolicy = get(TOKENS.CHAT_POLICY);
    return createTelegramLiveHandlers({
      manager,
      logger,
      botUserId: get(TOKENS.RENDER_PARAMS).botUserId ?? '0',
      eventSink: get(TOKENS.TELEGRAM_EVENT_SINK),
      chatPolicy: {
        isBlocked: chatPolicy.isBlocked,
        toBlockedMessageEvent: chatPolicy.toBlockedMessageEvent,
        blockedSenderIdsForChat: chatId => chatPolicy.blockedUserIdsByChat.get(chatId),
      },
      messageStore: get(TOKENS.TELEGRAM_MESSAGE_STORE),
      reactionStore: get(TOKENS.TELEGRAM_REACTION_STORE),
      driverControl: {
        handleTyping: (chatId, userId) => get(TOKENS.DRIVER).handleTyping(chatId, userId),
        setOfflineMode: (chatId, offline) => get(TOKENS.DRIVER).setOfflineMode(chatId, offline),
      },
    });
  });

  register(TOKENS.TELEGRAM_POST_STARTUP_TASKS, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) throw new Error('Telegram post-startup tasks requested without Telegram configured');
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const chatPolicy = get(TOKENS.CHAT_POLICY);
    const altText = get(TOKENS.ALT_TEXT_POLICY);
    const feature = get(TOKENS.FEATURE_SETS);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    return createTelegramPostStartupTasks({
      manager,
      logger,
      animationToTextChatIds: feature.animationToTextChatIds,
      animationToTextResolver: get(TOKENS.ANIMATION_TO_TEXT_RESOLVER),
      customEmojiToTextChatIds: feature.customEmojiToTextChatIds,
      customEmojiToTextResolver: get(TOKENS.CUSTOM_EMOJI_RESOLVER),
      animationMaxFrames: defaultChatConfig.animationToText.maxFrames,
      resolveChatPlatform: id => resolveChatConfig(config, id).platform,
      blockedSenderIdsForChat: chatId => chatPolicy.blockedUserIdsByChat.get(chatId),
      hydrateAltTextFromCache: event => altText.hydrateAltTextFromCache(event),
      walkCustomEmoji: (nodes, fn) => altText.walkCustomEmoji(nodes, fn),
      replayChat: (chatId, events) => pipeline.replayChat(chatId, events),
      loadCompaction: chatId => loadCompaction(db, chatId),
      loadEvents: (chatId, afterMs) => loadEvents(db, chatId, afterMs),
      loadEventsWithId: (chatId, afterMs) => loadEventsWithId(db, chatId, afterMs),
      loadMessageFileId: (chatId, messageId) => loadMessageFileId(db, chatId, messageId),
      updateEventAttachments: (eventId, attachments) => updateEventAttachments(db, eventId, attachments),
    });
  });

  register(TOKENS.TELEGRAM, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) return undefined;
    return startTelegram({
      manager,
      driverHooks: get(TOKENS.TELEGRAM_DRIVER_HOOKS),
      liveHandlers: get(TOKENS.TELEGRAM_LIVE_HANDLERS),
      postStartupTasks: get(TOKENS.TELEGRAM_POST_STARTUP_TASKS),
    });
  });

  // --- Background task manager ---

  register(TOKENS.BACKGROUND_TASK_MANAGER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const bgTasksConfig = get(TOKENS.BG_TASKS_CONFIG);
    const configuredChatIds = new Set(getChatIds(config));
    return createBackgroundTaskManager({
      db,
      persistEvent: event => persistEvent(db, event),
      pushPipelineEvent: (chatId, event) => isConfiguredChat(configuredChatIds, chatId) ? pipeline.pushEvent(chatId, event) : [],
      handleDriverEvent: (chatId, rc) => get(TOKENS.DRIVER).handleEvent(chatId, rc),
      taskOutputDir: bgTasksConfig.outputDir,
      retentionCount: bgTasksConfig.retentionCount,
      logger,
    });
  });

  // --- Driver ---

  register(TOKENS.DRIVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const runtimeConfig = get(TOKENS.RUNTIME_CONFIG);
    const platformRegistry = get(TOKENS.PLATFORM_REGISTRY);
    const telegram = get(TOKENS.TELEGRAM);
    const onebot = get(TOKENS.ONEBOT);
    const backgroundTaskManager = get(TOKENS.BACKGROUND_TASK_MANAGER);
    const chatIds = getChatIds(config);

    return createDriver({
      chatIds,
      resolveChatConfig: id => resolveChatConfig(config, id),
    }, {
      loadTurnResponses: (chatId, afterMs, agentId) => loadTurnResponses(db, chatId, afterMs, agentId),
      persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, tr),
      sendMessage: telegram
        ? (chatId, text, replyToMessageId, attachments) => telegram.driverHooks.sendMessage(chatId, text, replyToMessageId, attachments)
        : async () => { throw new Error('send_message not available: no Telegram configured'); },
      loadCompaction: chatId => loadCompaction(db, chatId),
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
          ? onebot.handle?.getAdapter(chatId)
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
  });

  return { container: c, get };
};
