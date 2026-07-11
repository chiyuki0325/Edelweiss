import sharp from 'sharp';

import { lookupFace } from './face-config';
import type { OneBotApiClient } from './server';
import type {
  OneBotMessageEvent,
  OneBotMessageSegment,
  OneBotNoticeEvent,
} from './types';
import type {
  CanonicalAttachment,
  CanonicalIMEvent,
  CanonicalMessageEvent,
  CanonicalUser,
  ContentNode,
} from '../adaption-types';

const captureUtcOffset = (): number => -new Date().getTimezoneOffset();

// Ingress metadata captured at the WS frame entry, before any network-bound
// adaptation. `receivedAtMs` is the ordering source of truth (see CLAUDE.md
// §Dual Timestamps) and must reflect the true receive moment, not the moment
// adaptation finishes.
export interface OneBotIngressMeta {
  receivedAtMs: number;
  utcOffsetMin: number;
}

export const captureOneBotIngressMeta = (): OneBotIngressMeta => ({
  receivedAtMs: Date.now(),
  utcOffsetMin: captureUtcOffset(),
});

export const oneBotMessageChatId = (event: OneBotMessageEvent): string =>
  event.message_type === 'group'
    ? String(event.group_id!)
    : `private:${event.user_id}`;

export interface OneBotSelfSentParams {
  chatId: string;
  messageId: string;
  selfId: string;
  text: string;
  replyToMessageId?: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

// Construct the synthetic CanonicalMessageEvent for a message the bot just sent.
// Mirrors Telegram's `injectSyntheticEvent` (src/telegram/driver-hooks.ts): the
// bot's own outbound messages must enter Projection so that user replies to them
// resolve `repliesToMe`, offline-mode mention/reply gating sees them, and they
// appear in IC/RC. The OneBot send API returns only a message id (no server
// timestamp), so `timestampSec` is derived from `receivedAtMs` like delete
// events (see CLAUDE.md §Dual Timestamps).
export const buildOneBotSelfSentEvent = (params: OneBotSelfSentParams): CanonicalMessageEvent => {
  const receivedAtMs = params.receivedAtMs ?? Date.now();
  const utcOffsetMin = params.utcOffsetMin ?? captureUtcOffset();
  const content: ContentNode[] = params.text ? [{ type: 'text', text: params.text }] : [];
  return {
    type: 'message',
    chatId: params.chatId,
    messageId: params.messageId,
    sender: { id: params.selfId, displayName: params.selfId, isBot: true },
    receivedAtMs,
    timestampSec: Math.floor(receivedAtMs / 1000),
    utcOffsetMin,
    content,
    attachments: [],
    isSelfSent: true,
    ...(params.replyToMessageId && { replyToMessageId: params.replyToMessageId }),
  };
};

export const adaptUser = (user_id: number, nickname: string, card?: string, remark?: string): CanonicalUser => ({
  id: String(user_id),
  displayName: [remark, card, nickname].find(name => name?.trim()) ?? nickname,
  isBot: false,
});

const nonBlank = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;

export const adaptOneBotSender = (event: OneBotMessageEvent): CanonicalUser => adaptUser(
  event.sender.user_id,
  nonBlank(event.raw?.sendNickName) ?? event.sender.nickname,
  nonBlank(event.raw?.sendMemberName) ?? event.sender.card,
  event.raw?.sendRemarkName,
);

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

  case 'json': {
    const card = JSON.parse(seg.data.data);
    const strip = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') return;

      for (const key of Object.keys(obj)) {
        const value = obj[key];

        // 判断是否需要删除当前字段
        if (
          value === null ||
            value === undefined ||
            value === '' ||
            (Array.isArray(value) && value.length === 0)
        ) {
          delete obj[key];
        } else if (typeof value === 'object') {
          // 递归
          strip(value);
        }
      }
    };
    strip(card);

    const keysToDelete = ['ver', 'config', 'app', 'view'];
    for (const key of keysToDelete) {
      delete card[key];
    }

    return {
      type: 'rich',
      text: JSON.stringify(card),
    };
  }

  // Unsupported segments: render as plain text description
  default:
    return null;
  }
};

// OneBotApiClient 传入用于某些消息（如 mention 的副作用）
export const adaptOneBotMessage = async (api: OneBotApiClient, event: OneBotMessageEvent, meta: OneBotIngressMeta): Promise<CanonicalMessageEvent> => {
  const chatId = oneBotMessageChatId(event);

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
    sender: adaptOneBotSender(event),
    receivedAtMs: meta.receivedAtMs,
    timestampSec: event.time,
    utcOffsetMin: meta.utcOffsetMin,
    content,
    attachments,
    ...(replyToMessageId && { replyToMessageId }),
  };
};

export const adaptOneBotNotice = (event: OneBotNoticeEvent, meta: OneBotIngressMeta): CanonicalIMEvent | null => {
  switch (event.notice_type) {
  case 'recall':
  case 'group_recall':
  {
    const chatId = event.group_id != null
      ? String(event.group_id)
      : `private:${event.user_id!}`;
    return {
      type: 'delete',
      chatId,
      messageIds: event.message_id != null ? [String(event.message_id)] : [],
      receivedAtMs: meta.receivedAtMs,
      timestampSec: Math.floor(meta.receivedAtMs / 1000),
      utcOffsetMin: meta.utcOffsetMin,
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
      receivedAtMs: meta.receivedAtMs,
      timestampSec: event.time,
      utcOffsetMin: meta.utcOffsetMin,
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
      receivedAtMs: meta.receivedAtMs,
      timestampSec: event.time,
      utcOffsetMin: meta.utcOffsetMin,
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
