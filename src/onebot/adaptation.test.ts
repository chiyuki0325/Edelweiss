import { afterEach, describe, expect, it, vi } from 'vitest';

import { adaptOneBotMessage, adaptOneBotSender, adaptUser } from './adaptation';
import type { OneBotApiClient } from './server';
import type { OneBotMessageEvent } from './types';
import { latestExternalEventMs, latestInterruptingExternalEventMs } from '../driver/context';
import { createEmptyIC, reduce } from '../projection';
import type { IntermediateContext } from '../projection';
import { render } from '../rendering';

afterEach(() => vi.unstubAllGlobals());

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
  const mentionEvent = (): OneBotMessageEvent => ({
    post_type: 'message',
    message_type: 'group',
    time: 1,
    self_id: 999,
    user_id: 42,
    group_id: 100,
    message_id: 7,
    message: [{ type: 'at', data: { qq: '123' } }],
    raw_message: '',
    sender: { user_id: 42, nickname: 'sender' },
  });

  it('keeps live individual mention lookup failures fail-closed', async () => {
    const api = {
      getFriendRemark: vi.fn().mockResolvedValue(undefined),
      getGroupMemberInfo: vi.fn().mockRejectedValue(new Error('OneBot API error: retcode=1200')),
    } as unknown as OneBotApiClient;

    await expect(adaptOneBotMessage(api, mentionEvent(), { receivedAtMs: 1000, utcOffsetMin: 480 }))
      .rejects.toThrow('retcode=1200');
  });

  it('renders all-member mentions without an individual member lookup', async () => {
    const getGroupMemberInfo = vi.fn().mockRejectedValue(new Error('invalid user ID'));
    const api = {
      getFriendRemark: vi.fn().mockResolvedValue(undefined),
      getGroupMemberInfo,
    } as unknown as OneBotApiClient;
    const event = mentionEvent();
    event.message = [{ type: 'at', data: { qq: 'all' } }];

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });

    expect(adapted.content).toEqual([{ type: 'text', text: '@全体成员' }]);
    expect(getGroupMemberInfo).not.toHaveBeenCalled();
  });

  it('preserves historical mention IDs inside merged forwards when member lookup fails', async () => {
    const error = new Error('OneBot API error: retcode=1200');
    const api = {
      getFriendRemark: vi.fn().mockResolvedValue(undefined),
      getGroupMemberInfo: vi.fn().mockRejectedValue(error),
    } as unknown as OneBotApiClient;
    const event = mentionEvent();
    event.message = [{ type: 'forward', data: { id: 'forward-id', content: [mentionEvent()] } }];
    const onMentionLookupFailure = vi.fn();

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 }, {
      onMentionLookupFailure,
    });

    expect(onMentionLookupFailure).toHaveBeenCalledWith(error, '123');
    expect(adapted.content).toMatchObject([{
      type: 'forward',
      messages: [{
        content: [{ type: 'mention', userId: '123', children: [{ type: 'text', text: '@123' }] }],
      }],
    }]);
  });

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

  it('adapts a shared-link news card into a link plus link preview', async () => {
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const card = {
      app: 'com.tencent.structmsg',
      view: 'news',
      prompt: '[分享]示例文章',
      meta: {
        news: {
          jumpUrl: 'https://b23.tv/stTsJEU',
          title: '示例文章',
          desc: '来自哔哩哔哩',
          tag: '哔哩哔哩',
          preview: 'https://example.com/preview.jpg',
        },
      },
    };
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'json', data: { data: JSON.stringify(card) } }],
      raw_message: '[分享]示例文章',
      sender: { user_id: 42, nickname: 'sender' },
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });

    expect(adapted.content).toEqual([
      { type: 'link', url: 'https://b23.tv/stTsJEU', children: [{ type: 'text', text: '示例文章' }] },
      {
        type: 'link_preview',
        url: 'https://b23.tv/stTsJEU',
        siteName: '哔哩哔哩',
        title: '示例文章',
        description: '来自哔哩哔哩',
      },
    ]);
  });

  it('keeps non-news JSON cards on the rich path', async () => {
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const card = {
      app: 'com.tencent.structmsg',
      prompt: '[QQ小程序]示例',
      meta: { detail_1: { title: '哔哩哔哩', desc: '示例', url: 'm.q.qq.com/a/s/example' } },
    };
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'json', data: { data: JSON.stringify(card) } }],
      raw_message: '[QQ小程序]示例',
      sender: { user_id: 42, nickname: 'sender' },
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });

    expect(adapted.content).toHaveLength(1);
    expect(adapted.content[0]?.type).toBe('rich');
  });

  it('does not fetch the temporary URL for ordinary images', async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'image', data: { file: 'ordinary.jpg', url: 'http://unreachable.invalid/ordinary.jpg', summary: '' } }],
      raw_message: '[图片]',
      sender: { user_id: 42, nickname: 'sender' },
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapted.attachments).toEqual([{
      type: 'photo',
      fileName: 'ordinary.jpg',
      fileRef: 'ordinary.jpg',
    }]);
  });

  it('keeps live sticker classification fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'image', data: { file: 'sticker.gif', url: 'http://unreachable.invalid/sticker.gif', summary: '[动画表情]' } }],
      raw_message: '[动画表情]',
      sender: { user_id: 42, nickname: 'sender' },
    };

    await expect(adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 }))
      .rejects.toThrow('fetch failed');
  });

  it('keeps historical sticker candidates when classification times out', async () => {
    const timeout = Object.assign(new TypeError('fetch failed'), {
      cause: { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));
    const onMediaClassificationFailure = vi.fn();
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 42,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'image', data: { file: 'sticker.gif', url: 'http://unreachable.invalid/sticker.gif', summary: '[动画表情]' } }],
      raw_message: '[动画表情]',
      sender: { user_id: 42, nickname: 'sender' },
    };

    const adapted = await adaptOneBotMessage(
      api,
      event,
      { receivedAtMs: 1000, utcOffsetMin: 480 },
      { onMediaClassificationFailure },
    );

    expect(onMediaClassificationFailure).toHaveBeenCalledWith(timeout);
    expect(adapted.attachments).toEqual([{
      type: 'sticker',
      fileName: 'sticker.gif',
      fileRef: 'sticker.gif',
    }]);
  });

  it('keeps an echoed self message transparent to Driver scheduling', async () => {
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 999,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'text', data: { text: 'self message' } }],
      raw_message: 'self message',
      sender: { user_id: 999, nickname: 'Bot' },
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });
    const rc = render(reduce(createEmptyIC('100'), adapted), { botUserId: 'telegram-bot-id' });

    expect(adapted.isMyself).toBe(true);
    expect(rc[0]?.isMyself).toBe(true);
    expect(latestExternalEventMs(rc, 0)).toBeNull();
    expect(latestInterruptingExternalEventMs(rc, 0)).toBeNull();
  });

  it('keeps self-derived rename events transparent when the live echo wins the race', async () => {
    const api = { getFriendRemark: vi.fn(async () => undefined) } as unknown as OneBotApiClient;
    const prior: IntermediateContext = reduce(createEmptyIC('100'), {
      type: 'message',
      chatId: '100',
      messageId: '6',
      sender: { id: '999', displayName: '999', isBot: true },
      receivedAtMs: 500,
      timestampSec: 0,
      utcOffsetMin: 480,
      content: [{ type: 'text', text: 'prior synthetic message' }],
      attachments: [],
      isMyself: true,
      isSelfSent: true,
    });
    const echo: OneBotMessageEvent = {
      post_type: 'message',
      message_type: 'group',
      time: 1,
      self_id: 999,
      user_id: 999,
      group_id: 100,
      message_id: 7,
      message: [{ type: 'text', data: { text: 'self message' } }],
      raw_message: 'self message',
      sender: { user_id: 999, nickname: 'Bot nickname' },
    };

    const adapted = await adaptOneBotMessage(api, echo, { receivedAtMs: 1000, utcOffsetMin: 480 });
    const rc = render(reduce(prior, adapted), { botUserId: 'telegram-bot-id' });

    expect(rc.at(-2)?.isMyself).toBe(true);
    expect(rc.at(-1)?.isMyself).toBe(true);
    expect(latestExternalEventMs(rc, 500)).toBeNull();
    expect(latestInterruptingExternalEventMs(rc, 500)).toBeNull();
  });

  it('reads merged forwards once and renders first-level senders and contents in order', async () => {
    const getForwardMessages = vi.fn(async () => [
      {
        user_id: 12,
        sender: { user_id: 12, nickname: 'Alice' },
        message: [
          { type: 'text', data: { text: '<hello>' } },
          { type: 'face', data: { id: '14' } },
          { type: 'json', data: { data: '{"meta":"<unsafe>"}' } },
        ],
      },
      {
        user_id: 34,
        sender: { user_id: 34, nickname: 'Bob' },
        message: [
          { type: 'text', data: { text: 'photo' } },
          { type: 'image', data: { file: 'photo.jpg' } },
          { type: 'forward', data: { id: 'nested' } },
        ],
      },
    ] as unknown as OneBotMessageEvent[]);
    const api = { getFriendRemark: vi.fn(async () => undefined), getForwardMessages } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message', message_type: 'group', time: 1, self_id: 999,
      user_id: 42, group_id: 100, message_id: 7, raw_message: '',
      sender: { user_id: 42, nickname: 'sender' },
      message: [{ type: 'text', data: { text: 'look: ' } }, { type: 'forward', data: { id: '7' } }],
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });
    const xml = render(reduce(createEmptyIC('100'), adapted), { botUserId: '999' })[0]?.content.find(piece => piece.type === 'text')?.text;

    expect(getForwardMessages).toHaveBeenCalledExactlyOnceWith('7');
    expect(adapted.attachments).toEqual([{ type: 'photo', fileName: 'photo.jpg', fileRef: 'photo.jpg' }]);
    expect(xml).toContain('look: <forwarded-messages><forwarded-message sender="Alice (12)">&lt;hello&gt;');
    expect(xml).toContain('&lt;unsafe&gt;');
    expect(xml).not.toContain('<unsafe>');
    expect(xml).toContain('<forwarded-message sender="Bob (34)">photo\\[附件见本消息末尾\\]\\[嵌套合并转发未展开\\]</forwarded-message>');
    expect(xml).toContain('<attachment type="photo"');
    expect(getForwardMessages).not.toHaveBeenCalledWith('nested');
  });

  it('uses inline forward content without requesting it again', async () => {
    const getForwardMessages = vi.fn();
    const api = { getFriendRemark: vi.fn(async () => undefined), getForwardMessages } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message', message_type: 'group', time: 1, self_id: 999,
      user_id: 42, group_id: 100, message_id: 7, raw_message: '',
      sender: { user_id: 42, nickname: 'sender' },
      message: [{
        type: 'forward', data: {
          id: '7', content: [{
            post_type: 'message', message_type: 'group', time: 1, self_id: 999,
            user_id: 12, group_id: 100, message_id: 8, raw_message: 'inline',
            sender: { user_id: 12, nickname: 'Alice' },
            message: [{ type: 'text', data: { text: 'inline' } }],
          }],
        },
      }],
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });
    expect(getForwardMessages).not.toHaveBeenCalled();
    expect(adapted.content).toEqual([{
      type: 'forward', messages: [{
        senderId: '12', senderName: 'Alice', content: [{ type: 'text', text: 'inline' }],
      }],
    }]);
  });

  it('does not count forwarded mentions as mentions of the bot', async () => {
    const api = {
      getFriendRemark: vi.fn(async () => undefined),
      getForwardMessages: vi.fn(async () => [{
        sender: { user_id: 12, nickname: 'Alice' },
        message: [{ type: 'at', data: { qq: '999' } }],
      }] as unknown as OneBotMessageEvent[]),
      getGroupMemberInfo: vi.fn(async () => ({ id: '999', displayName: 'Bot', isBot: true })),
    } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message', message_type: 'group', time: 1, self_id: 999,
      user_id: 42, group_id: 100, message_id: 7, raw_message: '',
      sender: { user_id: 42, nickname: 'sender' },
      message: [{ type: 'forward', data: { id: '7' } }],
    };

    const adapted = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 });
    const rc = render(reduce(createEmptyIC('100'), adapted), { botUserId: '999' });
    expect(rc.some(segment => segment.mentionsMe)).toBe(false);
    expect(rc.flatMap(segment => segment.content).filter(piece => piece.type === 'text')
      .find(piece => piece.text.includes('<forwarded-messages>'))?.text)
      .toContain('@Bot');
  });

  it('propagates get_forward_msg failures to the existing ingress retry policy', async () => {
    const api = {
      getFriendRemark: vi.fn(async () => undefined),
      getForwardMessages: vi.fn(async () => { throw new Error('forward expired'); }),
    } as unknown as OneBotApiClient;
    const event: OneBotMessageEvent = {
      post_type: 'message', message_type: 'group', time: 1, self_id: 999,
      user_id: 42, group_id: 100, message_id: 7, raw_message: '',
      sender: { user_id: 42, nickname: 'sender' },
      message: [{ type: 'forward', data: { id: '7' } }],
    };
    await expect(adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 }))
      .rejects.toThrow('forward expired');

    const onForwardFetchFailure = vi.fn();
    const replayed = await adaptOneBotMessage(api, event, { receivedAtMs: 1000, utcOffsetMin: 480 }, { onForwardFetchFailure });
    expect(onForwardFetchFailure).toHaveBeenCalledOnce();
    expect(replayed.content).toEqual([{ type: 'text', text: '[合并转发内容不可用]' }]);
  });
});
