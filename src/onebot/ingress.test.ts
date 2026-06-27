import { describe, expect, it, vi } from 'vitest';

import { attemptWithBudget, createOneBotIngress } from './ingress';
import type { OneBotIngressDeps } from './ingress';
import type { OneBotMessageEvent, OneBotNoticeEvent } from './types';
import type { CanonicalIMEvent } from '../adaption-types';
import { setupLogger, useLogger } from '../config/logger';
import { createMessageDedup } from '../ingress/message-dedup';

setupLogger();

describe('attemptWithBudget', () => {
  it('returns true and stops once fn succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const promise = attemptWithBudget(async () => {
      attempts++;
      if (attempts < 3) throw new Error('boom');
    }, { budgetMs: 60_000, baseDelayMs: 100, maxDelayMs: 1000 });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });

  it('returns false when the next backoff would exceed the budget', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const giveUp = vi.fn();
    const promise = attemptWithBudget(async () => {
      attempts++;
      throw new Error('always fails');
    }, { budgetMs: 1500, baseDelayMs: 1000, maxDelayMs: 1000, onGiveUp: giveUp });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(false);
    // First attempt runs, backoff is 1000ms (< 1500 budget) so it sleeps once,
    // second attempt fails and the next 1000ms backoff would cross the deadline.
    expect(attempts).toBe(2);
    expect(giveUp).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('always runs the first attempt even with a zero budget', async () => {
    let attempts = 0;
    const ok = await attemptWithBudget(async () => {
      attempts++;
    }, { budgetMs: 0 });
    expect(ok).toBe(true);
    expect(attempts).toBe(1);
  });
});

const baseDeps = (overrides: Partial<OneBotIngressDeps>): OneBotIngressDeps => ({
  logger: useLogger('test'),
  getApi: () => null,
  isWhitelisted: () => true,
  isBlocked: () => false,
  toBlockedMessageEvent: event => ({
    type: 'blocked_message',
    chatId: event.chatId,
    messageId: event.messageId,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
  }),
  imageToTextChatIds: new Set(),
  imageToTextResolver: { resolve: () => Promise.reject(new Error('unused')) } as never,
  animationToTextResolver: { resolve: () => Promise.reject(new Error('unused')) } as never,
  getImageToTextCompression: () => ({ compress: false, pixelBudget: 0 }),
  persistEvent: () => {},
  hydrateAltTextFromCache: () => {},
  pushPipelineEvent: () => ({} as never),
  onDriverEvent: () => {},
  setOfflineMode: () => {},
  sendPlatformMessage: () => Promise.resolve(),
  dedup: createMessageDedup(),
  ...overrides,
});

const noticeRecall = (groupId: number, messageId: number): OneBotNoticeEvent => ({
  post_type: 'notice',
  notice_type: 'group_recall',
  time: Math.floor(Date.now() / 1000),
  self_id: 1,
  group_id: groupId,
  message_id: messageId,
});

const groupMessage = (groupId: number, messageId: number, text = 'hi'): OneBotMessageEvent => ({
  post_type: 'message',
  message_type: 'group',
  time: Math.floor(Date.now() / 1000),
  self_id: 1,
  user_id: 42,
  group_id: groupId,
  message_id: messageId,
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { user_id: 42, nickname: 'alice' },
});

const meta = () => ({ receivedAtMs: Date.now(), utcOffsetMin: 0 });

// Minimal API stub: text-only messages never touch the network, but
// transformMessage still calls getApi() and throws if it returns null.
const stubApi = () => ({} as NonNullable<ReturnType<OneBotIngressDeps['getApi']>>);

describe('createOneBotIngress', () => {
  it('commits notice events through the queue and applies ingress meta', async () => {
    const persisted: CanonicalIMEvent[] = [];
    const ingress = createOneBotIngress(baseDeps({
      persistEvent: event => persisted.push(event),
    }));

    const m = { receivedAtMs: 123456, utcOffsetMin: 480 };
    ingress.enqueue(noticeRecall(100, 7), m);

    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    const event = persisted[0]!;
    expect(event.type).toBe('delete');
    expect(event.chatId).toBe('100');
    expect(event.receivedAtMs).toBe(123456);
    expect(event.utcOffsetMin).toBe(480);
  });

  it('drops events from non-whitelisted chats', async () => {
    const persisted: CanonicalIMEvent[] = [];
    const ingress = createOneBotIngress(baseDeps({
      isWhitelisted: chatId => chatId === '200',
      persistEvent: event => persisted.push(event),
    }));

    ingress.enqueue(noticeRecall(999, 1), meta());
    ingress.enqueue(noticeRecall(200, 2), meta());

    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    expect(persisted[0]!.chatId).toBe('200');
  });

  it('admits a message only once when the same (chatId, messageId) is enqueued twice', async () => {
    const persisted: CanonicalIMEvent[] = [];
    const ingress = createOneBotIngress(baseDeps({
      getApi: stubApi,
      persistEvent: event => persisted.push(event),
    }));

    ingress.enqueue(groupMessage(100, 7), meta());
    ingress.enqueue(groupMessage(100, 7), meta());

    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    // Settle to prove the duplicate never commits a second event.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.type).toBe('message');
  });

  it('lets the cold-start history pull skip a message the live path already reserved', async () => {
    const persisted: CanonicalIMEvent[] = [];
    // A single shared dedup models the startup wiring: live ingress and the
    // history pull consult the same instance, so the overlap window commits once.
    const dedup = createMessageDedup();
    const ingress = createOneBotIngress(baseDeps({
      getApi: stubApi,
      persistEvent: event => persisted.push(event),
      dedup,
    }));

    ingress.enqueue(groupMessage(100, 7), meta());
    await vi.waitFor(() => expect(persisted).toHaveLength(1));

    // History pull reaches the same message — its tryAdd returns false, so the
    // caller filters it out and never re-enqueues it.
    expect(dedup.tryAdd('100', 7)).toBe(false);

    // A genuinely new message from either path is still admitted.
    expect(dedup.tryAdd('100', 8)).toBe(true);
    ingress.enqueue(groupMessage(100, 9), meta());
    await vi.waitFor(() => expect(persisted).toHaveLength(2));
  });
});
