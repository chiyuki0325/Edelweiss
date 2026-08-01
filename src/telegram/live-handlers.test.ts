import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupLogger, useLogger } from '../config/logger';
import type { PipelineEvent } from '../pipeline';
import type { TelegramEventSink } from './event-sink';
import { createTelegramLiveHandlers } from './live-handlers';
import type { TelegramManager } from './manager';
import type { TelegramReactionCountUpdate, TelegramReactionSnapshotEntry, TelegramReactionUpdate, TelegramUser, TelegramUserReactionUpdate } from './message/types';
import type { TelegramMessageStore, TelegramReactionStore } from './stores';

setupLogger();

const user: TelegramUser = {
  id: '42',
  firstName: 'Alice',
  isBot: false,
  isPremium: false,
};

const userReaction = (overrides: Partial<TelegramUserReactionUpdate> = {}): TelegramUserReactionUpdate => ({
  kind: 'user',
  chatId: '-100123',
  messageId: 10,
  sender: user,
  oldReactions: [],
  newReactions: ['👍'],
  date: 1_700_000_000,
  receivedAtMs: 1_700_000_000_000,
  utcOffsetMin: 480,
  ...overrides,
});

const countReaction = (overrides: Partial<TelegramReactionCountUpdate> = {}): TelegramReactionCountUpdate => ({
  kind: 'count',
  chatId: '-100123',
  messageId: 10,
  counts: {},
  date: 1_700_000_000,
  receivedAtMs: 1_700_000_000_000,
  utcOffsetMin: 480,
  ...overrides,
});

const createHarness = async () => {
  let onReactionUpdate: ((update: TelegramReactionUpdate) => void) | undefined;
  const commands = new Map<string, (chatId: string) => Promise<void>>();
  const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1, text: '' }));
  const manager = {
    start: vi.fn(async () => {}),
    onMessage: vi.fn(),
    onMessageEdit: vi.fn(),
    onMessageDelete: vi.fn(),
    onReactionUpdate: vi.fn((handler: (update: TelegramReactionUpdate) => void) => {
      onReactionUpdate = handler;
    }),
    onTyping: vi.fn(),
    bot: {
      registerCommand: vi.fn((name: string, _description: string, handler: (chatId: string) => Promise<void>) => {
        commands.set(name, handler);
      }),
      sendMessage,
    },
  } as unknown as TelegramManager;

  const accepted: PipelineEvent[] = [];
  const eventSink = {
    accept: vi.fn((event: PipelineEvent) => {
      accepted.push(event);
      return undefined;
    }),
    persist: vi.fn(),
    publish: vi.fn(),
    isConfiguredChat: vi.fn(() => true),
  } satisfies TelegramEventSink;

  const snapshotKey = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
  const snapshots = new Map<string, TelegramReactionSnapshotEntry[]>();
  const reactionStore = {
    loadSnapshot: vi.fn((chatId: string, messageId: string) => snapshots.get(snapshotKey(chatId, messageId))),
    upsertSnapshot: vi.fn((chatId: string, messageId: string, entries: TelegramReactionSnapshotEntry[]) => {
      snapshots.set(snapshotKey(chatId, messageId), entries);
    }),
  } satisfies TelegramReactionStore;

  const requestCompaction = vi.fn(async () => ({ status: 'skipped' as const, reason: 'no_content' as const }));
  const handlers = createTelegramLiveHandlers({
    manager,
    logger: useLogger('test'),
    botUserId: '0',
    eventSink,
    chatPolicy: {
      isBlocked: vi.fn(() => false),
      toBlockedMessageEvent: vi.fn(),
      blockedSenderIdsForChat: vi.fn(),
    },
    messageStore: {
      loadLatestMessageContent: vi.fn(),
      persistMessage: vi.fn(),
      persistMessageEdit: vi.fn(),
      persistMessageDelete: vi.fn(),
    } satisfies TelegramMessageStore,
    reactionStore,
    driverControl: {
      handleTyping: vi.fn(),
      setOfflineMode: vi.fn(),
      requestCompaction,
    },
  });
  await handlers.start();

  if (!onReactionUpdate) throw new Error('reaction handler was not registered');
  return {
    accepted,
    eventSink,
    emitReaction: onReactionUpdate,
    snapshots,
    commands,
    requestCompaction,
    sendMessage,
  };
};

describe('createTelegramLiveHandlers commands', () => {
  it('registers /compact and reports a no-op compaction', async () => {
    const { commands, requestCompaction, sendMessage } = await createHarness();

    await commands.get('compact')!('-100123');

    expect(requestCompaction).toHaveBeenCalledWith('-100123');
    expect(sendMessage).toHaveBeenCalledWith('-100123', 'Nothing to compact.');
  });
});

describe('createTelegramLiveHandlers reaction debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays reaction events before they enter the pipeline', async () => {
    vi.useFakeTimers();
    const { accepted, emitReaction } = await createHarness();

    emitReaction(userReaction());

    expect(accepted).toEqual([]);
    await vi.advanceTimersByTimeAsync(499);
    expect(accepted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(accepted).toMatchObject([{
      type: 'reaction',
      chatId: '-100123',
      messageId: '10',
      sender: { id: '42', displayName: 'Alice' },
      emoji: '👍',
      count: 1,
    }]);
  });

  it('drops a user reaction that is removed inside the debounce window', async () => {
    vi.useFakeTimers();
    const { accepted, emitReaction, snapshots } = await createHarness();

    emitReaction(userReaction());
    await vi.advanceTimersByTimeAsync(250);
    emitReaction(userReaction({ oldReactions: ['👍'], newReactions: [] }));
    await vi.advanceTimersByTimeAsync(500);

    expect(accepted).toEqual([]);
    expect(snapshots.get('-100123:10')).toEqual([]);
  });

  it('cancels pending reaction events from count snapshots when the actor disappears', async () => {
    vi.useFakeTimers();
    const { accepted, emitReaction } = await createHarness();

    emitReaction(userReaction());
    await vi.advanceTimersByTimeAsync(250);
    emitReaction(countReaction({
      snapshot: [],
    }));
    await vi.advanceTimersByTimeAsync(500);

    expect(accepted).toEqual([]);
  });
});
