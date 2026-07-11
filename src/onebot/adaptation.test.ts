import { describe, expect, it } from 'vitest';

import { adaptOneBotMessage, adaptOneBotSender, adaptUser } from './adaptation';
import type { OneBotApiClient } from './server';
import type { OneBotMessageEvent } from './types';

describe('adaptUser', () => {
  it('prefers remark over group card and nickname', () => {
    expect(adaptUser(42, 'nickname', 'group card', 'remark').displayName).toBe('remark');
  });

  it('falls back from blank remark to group card', () => {
    expect(adaptUser(42, 'nickname', 'group card', '  ').displayName).toBe('group card');
  });

  it('falls back from blank group card to nickname', () => {
    expect(adaptUser(42, 'nickname', '', undefined).displayName).toBe('nickname');
  });
});

describe('adaptOneBotSender', () => {
  const event = (overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent => ({
    post_type: 'message',
    message_type: 'group',
    time: 1,
    self_id: 1,
    user_id: 42,
    group_id: 100,
    message_id: 7,
    message: [],
    raw_message: '',
    sender: { user_id: 42, nickname: 'standard nickname', card: 'standard card' },
    ...overrides,
  });

  it('uses the NapCat raw remark before member name and nickname', () => {
    const user = adaptOneBotSender(event({
      raw: {
        sendRemarkName: '好友备注',
        sendMemberName: '群昵称',
        sendNickName: 'QQ昵称',
      },
    }));

    expect(user.displayName).toBe('好友备注');
  });

  it('prefers a friend-list remark over event names', () => {
    const user = adaptOneBotSender(event({
      raw: { sendRemarkName: '原始备注', sendMemberName: '群昵称', sendNickName: 'QQ昵称' },
    }), '好友列表备注');

    expect(user.displayName).toBe('好友列表备注');
  });

  it('falls back through NapCat member name and nickname', () => {
    expect(adaptOneBotSender(event({
      raw: { sendRemarkName: '', sendMemberName: '群昵称', sendNickName: 'QQ昵称' },
    })).displayName).toBe('群昵称');
    expect(adaptOneBotSender(event({
      sender: { user_id: 42, nickname: 'standard nickname', card: '' },
      raw: { sendRemarkName: '', sendMemberName: '', sendNickName: 'QQ昵称' },
    })).displayName).toBe('QQ昵称');
  });

  it('keeps standard OneBot card and nickname fallbacks without raw data', () => {
    expect(adaptOneBotSender(event()).displayName).toBe('standard card');
    expect(adaptOneBotSender(event({
      sender: { user_id: 42, nickname: 'standard nickname', card: '' },
    })).displayName).toBe('standard nickname');
  });
});

describe('adaptOneBotMessage', () => {
  it('resolves the sender remark through the OneBot friend list API', async () => {
    const getFriendRemark = vi.fn(async () => '好友列表备注');
    const api = { getFriendRemark } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 1,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'text', data: { text: 'hello' } }],
      raw_message: 'hello',
      sender: { user_id: 42, nickname: 'QQ昵称', card: '' },
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });

    expect(getFriendRemark).toHaveBeenCalledWith('42');
    expect(adapted.sender?.displayName).toBe('好友列表备注');
  });
});
