import sharp from 'sharp';

import { lookupFace } from './face-config';
import type { OneBotApiClient } from './server';
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

export const adaptUser = (user_id: number, nickname: string, card?: string): CanonicalUser => ({
  id: String(user_id),
  displayName: card && card !== '' ? card : nickname,
  isBot: false,
});

const extractFileName = (file: string): string | undefined => {
  const lastSlash = file.lastIndexOf('/');
  const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
  return name || undefined;
};

const STICKER_REGEX = /^\[.*\]$/;

const adaptSegment = async (
  api: OneBotApiClient,
  chatId: string,
  seg: OneBotMessageSegment,
  attachments: CanonicalAttachment[],
): Promise<ContentNode | null> => {
  switch (seg.type) {
  case 'text':
    return { type: 'text', text: seg.data.text };

  case 'face': {
    const desc = lookupFace(seg.data.id) ?? `[QQ表情:${seg.data.id}]`;
    return { type: 'face', faceId: seg.data.id, text: desc };
  }

  case 'at':
    // napcat 上报的 mention 事件不带 name，所以需要自己拉
    const userMentioned = await api.getGroupMemberInfo(chatId, seg.data.qq);
    return { type: 'mention', userId: String(seg.data.qq), children: [{ type: 'text', text: `@${userMentioned.displayName}` }] };

  case 'image': {
    const response = await fetch(seg.data.url!, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());

    // 20260513 增加贴纸判断
    let attType: CanonicalAttachment['type'] = 'photo';
    const isStickerOrAnimation = seg.data.emoji_id != null || seg.data.emoji_pack_id != null || STICKER_REGEX.test(seg.data.summary ?? '');
    if (isStickerOrAnimation) {
      // 采用 sharp 判断是否为动画贴纸（多帧图片）
      const metadata = await sharp(buffer).metadata();
      const isAnimated = metadata.pages && metadata.pages > 1;
      attType = isAnimated ? 'animation' : 'sticker';
    }
    const att: CanonicalAttachment = {
      type: attType,

      // https://github.com/NapNeko/NapCatQQ/issues/313
      // 图片的 fileName 和 fileRef 相同，都为图片文件名
      // 我们可以直接 get_file / get_image 拿到 base64 编码的图片数据
      fileName: seg.data.file,
      fileRef: seg.data.file,
    };
    attachments.push(att);
    return null;
  }

  case 'record': {
    const att: CanonicalAttachment = {
      type: 'voice',
      fileName: extractFileName(seg.data.file),
      fileRef: seg.data.file,
    };
    attachments.push(att);
    return null;
  }

  case 'video': {
    const att: CanonicalAttachment = {
      type: 'video',
      fileName: extractFileName(seg.data.file),
      fileRef: seg.data.file,
    };
    attachments.push(att);
    return null;
  }

  case 'file': {
    const att: CanonicalAttachment = {
      type: 'document',
      fileName: seg.data.file,
      fileRef: seg.data.file_id,
    };
    attachments.push(att);
    return null;
  }

  // Unsupported segments: render as plain text description
  default:
    return null;
  }
};

// OneBotApiClient 传入用于某些消息（如 mention 的副作用）
export const adaptOneBotMessage = async (api: OneBotApiClient, event: OneBotMessageEvent): Promise<CanonicalMessageEvent> => {
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
    const node = await adaptSegment(api, chatId, seg, attachments);
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
  case 'recall':
  case 'group_recall':
  {
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
