import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent } from '../../adaption-types';
import { getChatIds, resolveChatConfig } from '../../config/config';
import type { Registrar } from '../registrar';
import type { ChatPolicy } from '../tokens';
import { TOKENS } from '../tokens';

export default function registerChatPolicy({ get, register }: Registrar): void {
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
}
