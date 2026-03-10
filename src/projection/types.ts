import type { CanonicalAttachment, CanonicalUser } from '../adaptation/types';

export interface ICMessage {
  type: 'message';
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

// TODO: Concrete fields TBD when implementing MetaReducer.
// Candidates: user rename, avatar change, join/leave, premium status change.
export interface ICSystemEvent {
  type: 'system_event';
  timestamp: number;
}

export type ICNode = ICMessage | ICSystemEvent;

export interface ICUserState {
  user: CanonicalUser;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
}

export interface IntermediateContext {
  chatId: string;
  nodes: ICNode[];
  users: Map<string, ICUserState>;
  epoch: number;
}

export const createEmptyIC = (chatId: string): IntermediateContext => ({
  chatId,
  nodes: [],
  users: new Map(),
  epoch: 0,
});
