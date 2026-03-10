import type { CanonicalAttachment, CanonicalUser } from '../adaptation/types';

export interface ICMessage {
  // String for cross-platform compatibility — Projection converts from
  // CanonicalEvent's numeric messageId via String()
  messageId: string;
  sender: CanonicalUser;
  timestamp: number;
  text?: string;
  // String for same reason as messageId
  replyToMessageId?: string;
  attachments: CanonicalAttachment[];
}

export interface ICUserState {
  user: CanonicalUser;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
}

export interface IntermediateContext {
  chatId: string;
  messages: ICMessage[];
  users: Map<string, ICUserState>;
  epoch: number;
  compactCursor: number;
}

export const createEmptyIC = (chatId: string): IntermediateContext => ({
  chatId,
  messages: [],
  users: new Map(),
  epoch: 0,
  compactCursor: 0,
});
