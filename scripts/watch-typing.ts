/**
 * Watch real-time "user is typing" events in a specified Telegram group chat.
 *
 * Usage: npx tsx scripts/watch-typing.ts <chat_id>
 *   chat_id: Telegram chat ID
 *     - Supergroup/channel: -1001234567890
 *     - Basic group:        -1234567890
 */
import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { Raw } from 'telegram/events';
import { StringSession } from 'telegram/sessions';

import { loadConfig } from '../src/config/config';
import { createGramjsLogger } from '../src/telegram/gramjs-logger';
import { loadSession } from '../src/telegram/session';

const ACTION_LABELS: Record<string, string> = {
  SendMessageTypingAction: '正在输入...',
  SendMessageCancelAction: '停止输入',
  SendMessageRecordVideoAction: '正在录制视频',
  SendMessageUploadVideoAction: '正在上传视频',
  SendMessageRecordAudioAction: '正在录制语音',
  SendMessageUploadAudioAction: '正在上传语音',
  SendMessageUploadPhotoAction: '正在上传图片',
  SendMessageUploadDocumentAction: '正在上传文件',
  SendMessageChooseStickerAction: '正在选择贴纸',
  SendMessageRecordRoundAction: '正在录制视频消息',
  SendMessageUploadRoundAction: '正在上传视频消息',
  SendMessageGeoLocationAction: '正在分享位置',
  SendMessageChooseContactAction: '正在选择联系人',
  SendMessageGamePlayAction: '正在玩游戏',
};

const getActionLabel = (action: Api.TypeSendMessageAction): string =>
  ACTION_LABELS[action.className] ?? action.className;

// Parse Telegram chat ID into { isChannel, rawId }
// Supergroup: -1001234567890  →  isChannel=true,  rawId=1234567890
// Basic group: -1234567890   →  isChannel=false, rawId=1234567890
const parseChatId = (arg: string): { isChannel: boolean; rawId: bigInt.BigInteger } => {
  const s = arg.trim();
  if (s.startsWith('-100'))
    return { isChannel: true, rawId: bigInt(s.slice(4)) };
  if (s.startsWith('-'))
    return { isChannel: false, rawId: bigInt(s.slice(1)) };
  return { isChannel: false, rawId: bigInt(s) };
};

const resolvePeerUserId = (peer: Api.TypePeer): bigInt.BigInteger | null => {
  if (peer instanceof Api.PeerUser) return peer.userId;
  if (peer instanceof Api.PeerChannel) return peer.channelId;
  if (peer instanceof Api.PeerChat) return peer.chatId;
  return null;
};

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('watch-typing');

  const chatIdArg = process.argv[2];
  if (!chatIdArg) {
    console.error('Usage: npx tsx scripts/watch-typing.ts <chat_id>');
    console.error('  Supergroup: -1001234567890');
    console.error('  Basic group: -1234567890');
    process.exit(1);
  }

  const config = loadConfig();
  if (config.telegram.apiId == null || config.telegram.apiHash == null)
    throw new Error('telegram.apiId and telegram.apiHash are required');

  const session = new StringSession(loadSession(config.telegram.session ?? ''));
  const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 3,
    baseLogger: createGramjsLogger(log),
  });

  await client.connect();
  if (!(await client.isUserAuthorized()))
    throw new Error('Userbot session is not authorized. Run `pnpm login` first.');

  const { isChannel, rawId } = parseChatId(chatIdArg);
  log.withFields({ chatId: chatIdArg, isChannel, rawId: rawId.toString() }).log('Watching typing events');

  // The server only sends typing updates to clients it considers "online."
  // Android Telegram maintains online status via account.updateStatus(offline=false) every ~55s.
  // A one-shot markAsRead is not enough — the server's "client is active" state decays.
  // We replicate the Android client's behavior:
  //   1. account.updateStatus(offline=false) — periodic heartbeat (every 50s)
  //   2. markAsRead — signal interest in this specific chat
  //   3. For supergroups: updates.getChannelDifference — periodic poll (server-provided timeout)
  const peer = await client.getInputEntity(chatIdArg);

  // (1) Online status heartbeat — the single most critical signal.
  const sendOnlineHeartbeat = async () => {
    try {
      await client.invoke(new Api.account.UpdateStatus({ offline: false }));
    } catch (err) {
      log.withError(err).warn('Failed to send online heartbeat');
    }
  };
  await sendOnlineHeartbeat();
  const heartbeatInterval = setInterval(() => { void sendOnlineHeartbeat(); }, 50_000);
  log.log('Online heartbeat started (every 50s)');

  // (2) Read history — marks the chat as "being viewed."
  await client.markAsRead(peer);
  log.log('Primed chat activity (markAsRead)');

  // (3) For supergroups: periodic getChannelDifference poll.
  // The server includes typing events in the response and provides a `timeout` for re-poll.
  let channelDiffTimeout: ReturnType<typeof setTimeout> | null = null;
  if (isChannel) {
    let channelPts = 1;
    const pollChannelDifference = async () => {
      try {
        const inputChannel = peer as Api.InputPeerChannel;
        const result = await client.invoke(new Api.updates.GetChannelDifference({
          channel: new Api.InputChannel({ channelId: inputChannel.channelId, accessHash: inputChannel.accessHash }),
          filter: new Api.ChannelMessagesFilterEmpty(),
          pts: channelPts,
          limit: 100,
          force: false,
        }));
        // Server tells us when to re-poll via the timeout field.
        const nextSec = 'timeout' in result && typeof result.timeout === 'number' ? result.timeout : 30;
        // Update pts for next call if available.
        if ('pts' in result && typeof result.pts === 'number') {
          channelPts = result.pts;
        }
        channelDiffTimeout = setTimeout(() => { void pollChannelDifference(); }, nextSec * 1000);
      } catch (err) {
        log.withError(err).warn('getChannelDifference failed, retrying in 30s');
        channelDiffTimeout = setTimeout(() => { void pollChannelDifference(); }, 30_000);
      }
    };
    // Seed pts from getFullChannel or just start polling.
    try {
      const inputChannel = peer as Api.InputPeerChannel;
      const full = await client.invoke(new Api.channels.GetFullChannel({
        channel: new Api.InputChannel({ channelId: inputChannel.channelId, accessHash: inputChannel.accessHash }),
      }));
      channelPts = (full.fullChat as Api.ChannelFull).pts ?? 1;
      log.withFields({ pts: channelPts }).log('Seeded channel pts');
    } catch (err) {
      log.withError(err).warn('Failed to seed channel pts, starting from 1');
    }
    void pollChannelDifference();
    log.log('Channel difference polling started');
  }

  const nameCache = new Map<string, string>();

  const resolveUserName = async (peer: Api.TypePeer): Promise<string> => {
    const userId = resolvePeerUserId(peer);
    if (!userId) return 'Unknown';

    const key = userId.toString();
    if (nameCache.has(key)) return nameCache.get(key)!;

    try {
      const entity = await client.getEntity(userId as unknown as Parameters<typeof client.getEntity>[0]);
      let name: string;
      if (entity instanceof Api.User) {
        const joined = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
        name = joined || (entity.username ?? key);
      } else if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
        name = entity.title || key;
      } else {
        name = key;
      }
      nameCache.set(key, name);
      return name;
    } catch {
      return key;
    }
  };

  const handleUpdate = async (update: Api.TypeUpdate) => {
    let matchedFromId: Api.TypePeer | null = null;
    let action: Api.TypeSendMessageAction | null = null;

    if (update instanceof Api.UpdateChannelUserTyping && isChannel) {
      if (!update.channelId.equals(rawId)) return;
      matchedFromId = update.fromId;
      action = update.action;
    } else if (update instanceof Api.UpdateChatUserTyping && !isChannel) {
      if (!update.chatId.equals(rawId)) return;
      matchedFromId = update.fromId;
      action = update.action;
    }

    if (!matchedFromId || !action) return;

    const userName = await resolveUserName(matchedFromId);
    const label = getActionLabel(action);
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${time}] ${userName}: ${label}`);
  };

  client.addEventHandler(
    (update: Api.TypeUpdate) => { void handleUpdate(update); },
    new Raw({ types: [Api.UpdateChannelUserTyping, Api.UpdateChatUserTyping] }),
  );

  const shutdown = async () => {
    log.log('Shutting down...');
    clearInterval(heartbeatInterval);
    if (channelDiffTimeout) clearTimeout(channelDiffTimeout);
    // Send offline status before disconnecting.
    try { await client.invoke(new Api.account.UpdateStatus({ offline: true })); } catch {}
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
};

main().catch(err => {
  useGlobalLogger('watch-typing').withError(err).error('Fatal error');
  process.exit(1);
});
