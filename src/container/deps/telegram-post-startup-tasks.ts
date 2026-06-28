import { resolveChatConfig } from '../../config/config';
import { loadCompaction, loadEvents, loadEventsWithId, loadMessageFileId, updateEventAttachments } from '../../db';
import { createTelegramPostStartupTasks } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramPostStartupTasks({ get, register }: Registrar): void {
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
      logger: get(TOKENS.LOGGER),
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
}
