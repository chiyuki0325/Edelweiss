import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode } from '../adaptation/types';

export interface ICMessage {
  type: 'message';
  messageId: string;
  sender: CanonicalUser;
  // receivedAt flows from the source event for merge ordering (see SPEC §RC and Turns — Orthogonal Merge)
  receivedAt: number;
  timestamp: number;
  content: ContentNode[];
  replyToMessageId?: string;
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
  editedAt?: number;
  deleted?: boolean;
}

// TODO: Concrete fields TBD when implementing MetaReducer.
// Candidates: user rename, avatar change, join/leave, premium status change.
export interface ICSystemEvent {
  type: 'system_event';
  // Inherited from the triggering event for merge ordering
  receivedAt: number;
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
  sessionId: string;
  nodes: ICNode[];
  users: Map<string, ICUserState>;
}

export const createEmptyIC = (sessionId: string): IntermediateContext => ({
  sessionId,
  nodes: [],
  users: new Map(),
});
