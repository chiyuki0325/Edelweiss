import type { Logger } from '@guiiai/logg';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { Raw } from 'telegram/events';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';

import { createEventBus } from './event-bus';
import { createGramjsLogger } from './gramjs-logger';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramReactionSnapshotEntry, TelegramUser } from './message';
import { fromGramjsAnyMessage, fromGramjsDeletedMessage, fromGramjsEditedMessage, resolveGramjsChatId, resolveGramjsSender } from './message';
import { isTypingLikeAction } from './typing-action';

export interface UserbotOptions {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface TypingEvent {
  chatId: string;
  userId: string;
}

export interface UserbotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  onTyping: (handler: (event: TypingEvent) => void) => void;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  fetchMessageReactions(chatId: string, messageId: number): Promise<TelegramReactionSnapshotEntry[]>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  refreshAvailableReactionEmojis(): Promise<string[]>;
  getAvailableReactionEmojis(): string[];
  refreshAllowedReactionEmojis(chatId: string): Promise<string[]>;
  getAllowedReactionEmojis(chatId: string): string[];
  raw(): TelegramClient;
  getSessionString(): string;
}

export interface FetchOptions {
  limit?: number;
  minId?: number;
  maxId?: number;
  offsetId?: number;
}

export const createUserbotClient = (options: UserbotOptions, logger: Logger): UserbotClient => {
  const log = logger.withContext('telegram:userbot');
  const session = new StringSession(options.session);
  const client = new TelegramClient(session, options.apiId, options.apiHash, {
    connectionRetries: 3,
    baseLogger: createGramjsLogger(log),
  });

  const messageBus = createEventBus<TelegramMessage>('userbot:message', log);
  const editBus = createEventBus<TelegramMessageEdit>('userbot:edit', log);
  const deleteBus = createEventBus<TelegramMessageDelete>('userbot:delete', log);
  const typingBus = createEventBus<TypingEvent>('userbot:typing', log);
  let availableReactionsHash = 0;
  let availableReactionEmojis: string[] = [];
  const allowedReactionEmojisByChat = new Map<string, string[]>();
  let eventHandlerRegistered = false;

  const reactionToEmoji = (reaction: Api.TypeReaction): string | undefined =>
    reaction instanceof Api.ReactionEmoji ? reaction.emoticon : undefined;

  const filterAvailableEmojiReactions = (reactions: Api.TypeAvailableReaction[]): string[] =>
    [...new Set(reactions
      .filter(r => r instanceof Api.AvailableReaction && !r.inactive && !r.premium)
      .map(r => r.reaction))];

  const resolveChatAllowedEmojiReactions = (
    availableReactions: Api.TypeChatReactions | undefined,
    globalEmojis: string[],
  ): string[] => {
    if (!availableReactions || availableReactions instanceof Api.ChatReactionsAll)
      return globalEmojis;
    if (availableReactions instanceof Api.ChatReactionsNone)
      return [];
    if (availableReactions instanceof Api.ChatReactionsSome) {
      const allowed = new Set(availableReactions.reactions.flatMap(r => {
        const emoji = reactionToEmoji(r);
        return emoji ? [emoji] : [];
      }));
      return globalEmojis.filter(emoji => allowed.has(emoji));
    }
    return globalEmojis;
  };

  const registerEventHandler = () => {
    if (eventHandlerRegistered) return;
    eventHandlerRegistered = true;

    client.addEventHandler(
      (event: NewMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        const msg = fromGramjsAnyMessage(event.message);
        if (msg) messageBus.emit(msg);
      },
      new NewMessage({}),
    );

    client.addEventHandler(
      (event: EditedMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        // MTProto fires updateEditMessage for metadata-only changes (link preview
        // loading, first reaction in large supergroups, inline keyboard updates,
        // edit_hide corrections). These "phantom edits" have no editDate.
        // Skip them here; reactions arrive through Bot API updates.
        if (!event.message.editDate) return;
        const msg = event.message;
        const sender = resolveGramjsSender(msg);
        editBus.emit(fromGramjsEditedMessage(msg, sender));
      },
      new EditedMessage({}),
    );

    client.addEventHandler(
      (event: DeletedMessageEvent) => {
        const peer = event.peer instanceof Api.PeerChannel ? event.peer : undefined;
        deleteBus.emit(fromGramjsDeletedMessage(event.deletedIds, peer));
      },
      new DeletedMessage({}),
    );

    client.addEventHandler(
      (update: Api.TypeUpdate) => {
        let chatId: string | undefined;
        let userId: string | undefined;

        if (update instanceof Api.UpdateChannelUserTyping) {
          chatId = `-100${update.channelId.toJSNumber()}`;
          if (update.fromId instanceof Api.PeerUser)
            userId = `${update.fromId.userId.toJSNumber()}`;
          if (isTypingLikeAction(update.action) && chatId && userId)
            typingBus.emit({ chatId, userId });
        } else if (update instanceof Api.UpdateChatUserTyping) {
          chatId = `-${update.chatId.toJSNumber()}`;
          if (update.fromId instanceof Api.PeerUser)
            userId = `${update.fromId.userId.toJSNumber()}`;
          if (isTypingLikeAction(update.action) && chatId && userId)
            typingBus.emit({ chatId, userId });
        }
      },
      new Raw({ types: [Api.UpdateChannelUserTyping, Api.UpdateChatUserTyping] }),
    );

    log.log('Event handlers registered');
  };

  const start = async () => {
    log.log('Connecting...');
    await client.connect();

    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      throw new Error(
        'Userbot session is not authorized. Run `pnpm login` to create a session first.',
      );
    }

    const me = await client.getMe();
    if (me instanceof Api.User) {
      log.withFields({
        id: me.id.toJSNumber(),
        username: me.username,
        name: [me.firstName, me.lastName].filter(Boolean).join(' '),
      }).log('Authenticated');
    }

    registerEventHandler();
    // Warm entity cache so getInputEntity can resolve channels before live updates arrive
    try {
      const dialogs = await client.getDialogs({});
      log.withFields({ count: dialogs.length }).log('Entity cache warmed via getDialogs');
    } catch (err) {
      log.withError(err).warn('Failed to warm entity cache via getDialogs');
    }

    try {
      const emojis = await refreshAvailableReactionEmojis();
      log.withFields({ count: emojis.length }).log('Available reaction emojis loaded');
    } catch (err) {
      log.withError(err).warn('Failed to load available reaction emojis');
    }
  };

  const stop = async () => {
    log.log('Disconnecting...');
    await client.destroy();
    log.log('Disconnected');
  };

  const fetchMessages = async (chatId: string, opts: FetchOptions): Promise<TelegramMessage[]> => {
    const messages = await client.getMessages(chatId, {
      limit: opts.limit ?? 100,
      minId: opts.minId,
      maxId: opts.maxId,
      offsetId: opts.offsetId,
    });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .flatMap(m => {
        const result = fromGramjsAnyMessage(m);
        return result ? [result] : [];
      });
  };

  const fetchSpecificMessages = async (chatId: string, messageIds: number[]): Promise<TelegramMessage[]> => {
    if (messageIds.length === 0) return [];

    const messages = await client.getMessages(chatId, { ids: messageIds });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .flatMap(m => {
        const result = fromGramjsAnyMessage(m);
        return result ? [result] : [];
      });
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const msgs = await client.getMessages(chatId, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || msg instanceof Api.MessageEmpty || !msg.media) return undefined;
    const result = await client.downloadMedia(msg, {});
    return Buffer.isBuffer(result) ? result : undefined;
  };

  const apiUserToTelegramUser = (user: Api.User): TelegramUser => ({
    id: String(user.id.toJSNumber()),
    firstName: user.firstName ?? '',
    lastName: user.lastName,
    username: user.username,
    isBot: user.bot ?? false,
    isPremium: user.premium ?? false,
  });

  const apiChatToTelegramUser = (chat: Api.TypeChat, id: string): TelegramUser => {
    if (chat instanceof Api.Channel) {
      return {
        id,
        firstName: chat.title,
        username: chat.username,
        isBot: false,
        isPremium: false,
      };
    }
    if (chat instanceof Api.Chat || chat instanceof Api.ChatForbidden || chat instanceof Api.ChannelForbidden) {
      return {
        id,
        firstName: chat.title,
        isBot: false,
        isPremium: false,
      };
    }
    return { id, firstName: id, isBot: false, isPremium: false };
  };

  const fetchMessageReactions = async (chatId: string, messageId: number): Promise<TelegramReactionSnapshotEntry[]> => {
    const peer = await client.getInputEntity(chatId);
    const snapshot: TelegramReactionSnapshotEntry[] = [];
    let offset: string | undefined;

    do {
      const result = await client.invoke(new Api.messages.GetMessageReactionsList({
        peer,
        id: messageId,
        limit: 100,
        offset,
      }));

      const users = new Map(
        result.users
          .filter((user): user is Api.User => user instanceof Api.User)
          .map(user => [String(user.id.toJSNumber()), apiUserToTelegramUser(user)]),
      );
      const chats = new Map(result.chats.map(chat => {
        let id = '';
        if (chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden)
          id = `-100${chat.id.toJSNumber()}`;
        else if (chat instanceof Api.Chat || chat instanceof Api.ChatForbidden)
          id = `-${chat.id.toJSNumber()}`;
        return [id, apiChatToTelegramUser(chat, id)] as const;
      }));

      for (const reaction of result.reactions) {
        const emoji = reactionToEmoji(reaction.reaction);
        if (!emoji) continue;

        const senderId = resolveGramjsChatId(reaction.peerId);
        const sender = reaction.peerId instanceof Api.PeerUser
          ? users.get(senderId)
          : chats.get(senderId);
        snapshot.push({
          emoji,
          sender: sender ?? { id: senderId, firstName: senderId, isBot: false, isPremium: false },
          date: reaction.date,
        });
      }

      offset = result.nextOffset;
    } while (offset);

    return snapshot;
  };

  const refreshAvailableReactionEmojis = async (): Promise<string[]> => {
    const result = await client.invoke(new Api.messages.GetAvailableReactions({
      hash: availableReactionsHash,
    }));

    if (result instanceof Api.messages.AvailableReactionsNotModified)
      return availableReactionEmojis;

    if (result instanceof Api.messages.AvailableReactions) {
      availableReactionsHash = result.hash;
      availableReactionEmojis = filterAvailableEmojiReactions(result.reactions);
    }
    return availableReactionEmojis;
  };

  const getAvailableReactionEmojis = (): string[] => availableReactionEmojis;

  const refreshAllowedReactionEmojis = async (chatId: string): Promise<string[]> => {
    const globalEmojis = await refreshAvailableReactionEmojis();
    const peer = await client.getInputEntity(chatId);
    let emojis = globalEmojis;

    if (peer instanceof Api.InputPeerChannel) {
      const full = await client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
      const fullChat = full.fullChat;
      if (fullChat instanceof Api.ChannelFull)
        emojis = resolveChatAllowedEmojiReactions(fullChat.availableReactions, globalEmojis);
    } else if (peer instanceof Api.InputPeerChat) {
      const full = await client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }));
      const fullChat = full.fullChat;
      if (fullChat instanceof Api.ChatFull)
        emojis = resolveChatAllowedEmojiReactions(fullChat.availableReactions, globalEmojis);
    }

    allowedReactionEmojisByChat.set(chatId, emojis);
    return emojis;
  };

  const getAllowedReactionEmojis = (chatId: string): string[] =>
    allowedReactionEmojisByChat.get(chatId) ?? [];

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    onTyping: typingBus.on,
    fetchMessages,
    fetchSpecificMessages,
    fetchMessageReactions,
    downloadMessageMedia,
    refreshAvailableReactionEmojis,
    getAvailableReactionEmojis,
    refreshAllowedReactionEmojis,
    getAllowedReactionEmojis,
    raw: () => client,
    getSessionString: () => String(client.session.save()),
  };
};
