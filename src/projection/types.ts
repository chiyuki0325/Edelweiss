import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode } from '../adaptation/types';

export interface ICMessage {
  type: 'message';
  messageId: string;
  sender: CanonicalUser;
  // receivedAt flows from the source event for merge ordering (see SPEC §RC and TRs — Orthogonal Merge)
  receivedAt: number;
  timestamp: number;
  content: ContentNode[];
  replyToMessageId?: string;
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
  editedAt?: number;
  deleted?: boolean;
}

export interface ICUserRenamedEvent {
  type: 'system_event';
  kind: 'user_renamed';
  receivedAt: number;
  timestamp: number;
  userId: string;
  oldUser: CanonicalUser;
  newUser: CanonicalUser;
}

// Extensible: add more event kinds (join/leave, etc.) to this union as needed.
export type ICSystemEvent = ICUserRenamedEvent;

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
