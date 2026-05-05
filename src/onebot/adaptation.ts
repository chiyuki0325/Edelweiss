import { lookupFace } from './face-config';
import type {
  OneBotMessageEvent,
  OneBotMessageSegment,
  OneBotNoticeEvent,
} from './types';
import { captureUtcOffset } from '../adaptation/index';
import type {
  CanonicalAttachment,
  CanonicalIMEvent,
  CanonicalMessageEvent,
  CanonicalUser,
  ContentNode,
} from '../adaptation/types';

const adaptUser = (user_id: number, nickname: string, card?: string): CanonicalUser => ({
  id: String(user_id),
  displayName: card && card !== '' ? card : nickname,
  isBot: false,
});

const extractFileName = (file: string): string | undefined => {
  const lastSlash = file.lastIndexOf('/');
  const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
  return name || undefined;
};

const adaptSegment = (
  seg: OneBotMessageSegment,
  attachments: CanonicalAttachment[],
): ContentNode | null => {
  switch (seg.type) {
  case 'text':
    return { type: 'text', text: seg.data.text };

  case 'face': {
    const desc = lookupFace(seg.data.id) ?? `[QQ表情:${seg.data.id}]`;
    return { type: 'face', faceId: seg.data.id, text: desc };
  }

  case 'at':
    return { type: 'mention', userId: String(seg.data.qq), children: [{ type: 'text', text: `@${seg.data.name ?? seg.data.qq}` }] };

  case 'image': {
    const att: CanonicalAttachment = {
      type: 'photo',
      fileName: extractFileName(seg.data.file),
    };
    attachments.push(att);
    return null;
  }

  case 'record': {
    const att: CanonicalAttachment = {
      type: 'voice',
      fileName: extractFileName(seg.data.file),
    };
    attachments.push(att);
    return null;
  }

  case 'video': {
    const att: CanonicalAttachment = {
      type: 'video',
      fileName: extractFileName(seg.data.file),
    };
    attachments.push(att);
    return null;
  }

  case 'file': {
    const att: CanonicalAttachment = {
      type: 'document',
      fileName: seg.data.name ?? extractFileName(seg.data.file),
    };
    attachments.push(att);
    return null;
  }

  // Unsupported segments: render as plain text description
  default:
    return null;
  }
};

export const adaptOneBotMessage = (event: OneBotMessageEvent): CanonicalMessageEvent => {
  const chatId = event.message_type === 'group'
    ? String(event.group_id!)
    : `private:${event.user_id}`;

  const content: ContentNode[] = [];
  const attachments: CanonicalAttachment[] = [];
  let replyToMessageId: string | undefined;

  for (const seg of event.message) {
    if (seg.type === 'reply') {
      replyToMessageId = String(seg.data.id);
      continue;
    }
    const node = adaptSegment(seg, attachments);
    if (node) content.push(node);
  }

  return {
    type: 'message',
    chatId,
    messageId: String(event.message_id),
    sender: adaptUser(event.sender.user_id, event.sender.nickname, event.sender.card),
    receivedAtMs: Date.now(),
    timestampSec: event.time,
    utcOffsetMin: captureUtcOffset(),
    content,
    attachments,
    ...(replyToMessageId && { replyToMessageId }),
  };
};

export const adaptOneBotNotice = (event: OneBotNoticeEvent): CanonicalIMEvent | null => {
  switch (event.notice_type) {
  case 'recall': {
    const chatId = event.group_id != null
      ? String(event.group_id)
      : `private:${event.user_id!}`;
    const now = Date.now();
    return {
      type: 'delete',
      chatId,
      messageIds: event.message_id != null ? [String(event.message_id)] : [],
      receivedAtMs: now,
      timestampSec: Math.floor(now / 1000),
      utcOffsetMin: captureUtcOffset(),
    };
  }

  case 'group_increase': {
    const senderId = event.user_id;
    if (!event.group_id || senderId == null) return null;
    return {
      type: 'service',
      chatId: String(event.group_id),
      actor: event.operator_id != null
        ? { id: String(event.operator_id), displayName: `user:${event.operator_id}`, isBot: false }
        : undefined,
      receivedAtMs: Date.now(),
      timestampSec: event.time,
      utcOffsetMin: captureUtcOffset(),
      action: {
        action: 'members_joined',
        members: [{ id: String(senderId), displayName: `user:${senderId}`, isBot: false }],
      },
    };
  }

  case 'group_decrease': {
    const senderId = event.user_id;
    if (!event.group_id || senderId == null) return null;
    return {
      type: 'service',
      chatId: String(event.group_id),
      actor: event.operator_id != null
        ? { id: String(event.operator_id), displayName: `user:${event.operator_id}`, isBot: false }
        : undefined,
      receivedAtMs: Date.now(),
      timestampSec: event.time,
      utcOffsetMin: captureUtcOffset(),
      action: {
        action: 'member_left',
        member: { id: String(senderId), displayName: `user:${senderId}`, isBot: false },
      },
    };
  }

  default:
    return null;
  }
};
