import { getChatIds, resolveChatConfig, resolveModel } from '../../config/config';
import { loadCompaction, loadTurnResponses, persistCompaction, persistTurnResponse } from '../../db';
import { createDriver } from '../../driver';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerDriver({ get, register }: Registrar): void {
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
      getChatName: chatId => resolveChatConfig(config, chatId).platform === 'onebot'
        ? onebot.handle?.getChatName(chatId) ?? Promise.resolve(chatId)
        : telegram?.manager.getChatName(chatId) ?? Promise.resolve(chatId),
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
      logger: get(TOKENS.LOGGER),
    });
  });
}
