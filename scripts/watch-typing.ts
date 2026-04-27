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
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
};

main().catch(err => {
  useGlobalLogger('watch-typing').withError(err).error('Fatal error');
  process.exit(1);
});
