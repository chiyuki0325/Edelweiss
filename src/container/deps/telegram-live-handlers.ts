import { createTelegramLiveHandlers } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramLiveHandlers({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_LIVE_HANDLERS, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) throw new Error('Telegram live handlers requested without Telegram configured');
    const chatPolicy = get(TOKENS.CHAT_POLICY);
    return createTelegramLiveHandlers({
      manager,
      logger: get(TOKENS.LOGGER),
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
}
