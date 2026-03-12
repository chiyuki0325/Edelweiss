import { enableMapSet, produce } from 'immer';

import type { ICMessage, ICSystemEvent, ICUserState, IntermediateContext } from './types';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalMessageEvent,
  CanonicalUser,
} from '../adaptation/types';

enableMapSet();

const userChanged = (a: CanonicalUser, b: CanonicalUser): boolean =>
  a.displayName !== b.displayName || a.username !== b.username;

const findMessageIndex = (nodes: readonly { type: string; messageId?: string }[], messageId: string): number => {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type === 'message' && (node as ICMessage).messageId === messageId) return i;
  }
  return -1;
};

const reduceMessage = (draft: IntermediateContext, event: CanonicalMessageEvent) => {
  if (!event.sender) return;

  const existing = draft.users.get(event.sender.id);

  // MetaReducer: detect user rename before appending the message
  if (existing && userChanged(existing.user, event.sender)) {
    const systemEvent: ICSystemEvent = {
      type: 'system_event',
      kind: 'user_renamed',
      receivedAt: event.receivedAt,
      timestamp: event.timestamp,
      userId: event.sender.id,
      oldUser: existing.user,
      newUser: event.sender,
    };
    draft.nodes.push(systemEvent);
  }

  const message: ICMessage = {
    type: 'message',
    messageId: event.messageId,
    sender: event.sender,
    receivedAt: event.receivedAt,
    timestamp: event.timestamp,
    content: event.content,
    attachments: event.attachments,
  };
  if (event.replyToMessageId) message.replyToMessageId = event.replyToMessageId;
  if (event.forwardInfo) message.forwardInfo = event.forwardInfo;
  draft.nodes.push(message);

  // Update user state
  if (existing) {
    existing.user = event.sender;
    existing.lastSeenAt = event.receivedAt;
    existing.messageCount++;
  } else {
    const state: ICUserState = {
      user: event.sender,
      firstSeenAt: event.receivedAt,
      lastSeenAt: event.receivedAt,
      messageCount: 1,
    };
    draft.users.set(event.sender.id, state);
  }
};

const reduceEdit = (draft: IntermediateContext, event: CanonicalEditEvent) => {
  const idx = findMessageIndex(draft.nodes, event.messageId);
  if (idx === -1) return;

  const node = draft.nodes[idx] as ICMessage;
  node.content = event.content;
  node.attachments = event.attachments;
  node.editedAt = event.timestamp;
};

const reduceDelete = (draft: IntermediateContext, event: CanonicalDeleteEvent) => {
  for (const messageId of event.messageIds) {
    const idx = findMessageIndex(draft.nodes, messageId);
    if (idx === -1) continue;
    (draft.nodes[idx] as ICMessage).deleted = true;
  }
};

export const reduce = (ic: IntermediateContext, event: CanonicalIMEvent): IntermediateContext =>
  produce(ic, draft => {
    switch (event.type) {
    case 'message': reduceMessage(draft, event); break;
    case 'edit': reduceEdit(draft, event); break;
    case 'delete': reduceDelete(draft, event); break;
    }
  });
