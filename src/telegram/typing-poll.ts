import type { Logger } from '@guiiai/logg';
import bigInt from 'big-integer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram';

import type { TypingEvent } from './userbot';

export interface TypingPollManager {
  startPolling(chatId: string): Promise<void>;
  stopPolling(chatId: string): void;
  stopAll(): void;
}

interface PollState {
  timer: ReturnType<typeof setTimeout> | null;
  pts: number;
  channelId: bigInt.BigInteger;
  accessHash: bigInt.BigInteger;
  running: boolean;
}

const TYPING_ACTION_CLASS = 'SendMessageTypingAction';

export const createTypingPollManager = (
  client: TelegramClient,
  onTyping: (event: TypingEvent) => void,
  logger: Logger,
): TypingPollManager => {
  const log = logger.withContext('typing-poll');
  const polls = new Map<string, PollState>();

  let lastOnlineHeartbeatAt = 0;
  const HEARTBEAT_THROTTLE_MS = 55_000;

  const sendOnlineHeartbeat = async () => {
    const now = Date.now();
    if (now - lastOnlineHeartbeatAt < HEARTBEAT_THROTTLE_MS) return;
    lastOnlineHeartbeatAt = now;
    try {
      await client.invoke(new Api.account.UpdateStatus({ offline: false }));
    } catch (err) {
      log.withError(err).warn('Failed to send online heartbeat');
    }
  };

  const parseSupergroupChatId = (chatId: string): bigInt.BigInteger | null => {
    if (!chatId.startsWith('-100')) return null;
    return bigInt(chatId.slice(4));
  };

  const resolveChannelPeer = async (chatId: string) => {
    const entity = await client.getInputEntity(chatId);
    if (!(entity instanceof Api.InputPeerChannel)) return null;
    return entity;
  };

  const pollLoop = async (state: PollState) => {
    if (!state.running) return;

    try {
      const result = await client.invoke(new Api.updates.GetChannelDifference({
        channel: new Api.InputChannel({
          channelId: state.channelId,
          accessHash: state.accessHash,
        }),
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts: state.pts,
        limit: 100,
        force: false,
      }));

      const nextSec = 'timeout' in result && typeof result.timeout === 'number' ? result.timeout : 30;
      if ('pts' in result && typeof result.pts === 'number') {
        state.pts = result.pts;
      }

      // Extract typing events from the response
      const updates: Api.TypeUpdate[] = [];
      if ('newUpdates' in result && Array.isArray(result.newUpdates)) {
        updates.push(...result.newUpdates);
      }
      if ('otherUpdates' in result && Array.isArray(result.otherUpdates)) {
        updates.push(...result.otherUpdates);
      }

      for (const update of updates) {
        if (update instanceof Api.UpdateChannelUserTyping && update.action.className === TYPING_ACTION_CLASS) {
          if (update.fromId instanceof Api.PeerUser) {
            onTyping({ chatId: `-100${String(state.channelId)}`, userId: String(update.fromId.userId) });
          }
        }
      }

      if (state.running) {
        state.timer = setTimeout(() => { void pollLoop(state); }, nextSec * 1000);
      }
    } catch (err) {
      log.withError(err).withFields({ channelId: String(state.channelId) }).warn('getChannelDifference failed, retrying in 30s');
      if (state.running) {
        state.timer = setTimeout(() => { void pollLoop(state); }, 30_000);
      }
    }
  };

  const startPolling = async (chatId: string) => {
    if (polls.has(chatId)) return;

    const channelId = parseSupergroupChatId(chatId);
    if (!channelId) return;

    const peer = await resolveChannelPeer(chatId);
    if (!peer) {
      log.withFields({ chatId }).warn('Failed to resolve channel peer for typing poll');
      return;
    }
    const accessHash = peer.accessHash;

    // Send online heartbeat before polling, throttled to once per 55s
    await sendOnlineHeartbeat();

    let pts = 1;
    try {
      const full = await client.invoke(new Api.channels.GetFullChannel({
        channel: new Api.InputChannel({ channelId, accessHash }),
      }));
      const channelFull = 'fullChat' in full ? (full.fullChat as Api.ChannelFull) : null;
      pts = channelFull?.pts ?? 1;
      log.withFields({ chatId, pts }).log('Seeded channel pts for typing poll');
    } catch (err) {
      log.withError(err).withFields({ chatId }).warn('Failed to seed channel pts, starting from 1');
    }

    const state: PollState = { timer: null, pts, channelId, accessHash, running: true };
    polls.set(chatId, state);

    log.withFields({ chatId }).log('Started typing poll');
    void pollLoop(state);
  };

  const stopPolling = (chatId: string) => {
    const state = polls.get(chatId);
    if (!state) return;
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    polls.delete(chatId);
    log.withFields({ chatId }).log('Stopped typing poll');
  };

  const stopAll = () => {
    for (const chatId of polls.keys())
      stopPolling(chatId);
  };

  return { startPolling, stopPolling, stopAll };
};
