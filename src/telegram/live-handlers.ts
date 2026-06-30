import type { Logger } from '@guiiai/logg';

import { adaptDelete, adaptEdit, adaptMessage, adaptReaction, adaptServiceEvent, contentToPlainText, isServiceMessage } from './adaption';
import type { TelegramEventSink } from './event-sink';
import type { TelegramManager } from './manager';
import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent } from '../adaption-types';
import type { TelegramReactionSnapshotEntry, TelegramReactionUpdate } from './message/types';
import type { TelegramMessageStore, TelegramReactionStore } from './stores';

export interface TelegramChatPolicy {
  isBlocked(chatId: string, senderId: string | undefined): boolean;
  toBlockedMessageEvent(event: CanonicalMessageEvent): CanonicalBlockedMessageEvent;
  blockedSenderIdsForChat(chatId: string): ReadonlySet<string> | undefined;
}

export interface TelegramDriverControl {
  handleTyping(chatId: string, userId: string): void;
  setOfflineMode(chatId: string, offline: boolean): void;
}

export interface TelegramLiveHandlers {
  start(): Promise<void>;
}

export interface TelegramLiveHandlersDeps {
  manager: TelegramManager;
  logger: Logger;
  botUserId: string;
  eventSink: TelegramEventSink;
  chatPolicy: TelegramChatPolicy;
  messageStore: TelegramMessageStore;
  reactionStore: TelegramReactionStore;
  driverControl: TelegramDriverControl;
}

const REACTION_DEBOUNCE_MS = 500;

const reactionEntryKey = (entry: TelegramReactionSnapshotEntry) =>
  `${entry.emoji}\u0000${entry.sender.id}`;

const pendingReactionKey = (chatId: string, messageId: string, emoji: string, senderId?: string) =>
  `${chatId}\u0000${messageId}\u0000${emoji}\u0000${senderId ?? ''}`;

interface PendingReactionEvent {
  reaction: TelegramReactionUpdate;
  emoji: string;
  count: number;
  sender?: TelegramReactionSnapshotEntry['sender'];
  timer: ReturnType<typeof setTimeout>;
}

export interface ReactionDebouncer {
  enqueue(
    reaction: TelegramReactionUpdate,
    emoji: string,
    count: number,
    sender?: TelegramReactionSnapshotEntry['sender'],
  ): void;
  cancel(chatId: string, messageId: string, emoji: string, senderId?: string): void;
}

export const createReactionDebouncer = (
  flush: (
    reaction: TelegramReactionUpdate,
    emoji: string,
    count: number,
    sender?: TelegramReactionSnapshotEntry['sender'],
  ) => void,
  debounceMs = REACTION_DEBOUNCE_MS,
): ReactionDebouncer => {
  const pending = new Map<string, PendingReactionEvent>();

  const cancel = (chatId: string, messageId: string, emoji: string, senderId?: string) => {
    const key = pendingReactionKey(chatId, messageId, emoji, senderId);
    const event = pending.get(key);
    if (!event) return;
    clearTimeout(event.timer);
    pending.delete(key);
  };

  const enqueue: ReactionDebouncer['enqueue'] = (reaction, emoji, count, sender) => {
    const key = pendingReactionKey(reaction.chatId, String(reaction.messageId), emoji, sender?.id);
    cancel(reaction.chatId, String(reaction.messageId), emoji, sender?.id);
    const timer = setTimeout(() => {
      const event = pending.get(key);
      if (!event) return;
      pending.delete(key);
      flush(event.reaction, event.emoji, event.count, event.sender);
    }, debounceMs);
    pending.set(key, { reaction, emoji, count, sender, timer });
  };

  return { enqueue, cancel };
};

export const createTelegramLiveHandlers = (deps: TelegramLiveHandlersDeps): TelegramLiveHandlers => {
  const persistReactionEvent = (
    reaction: TelegramReactionUpdate,
    emoji: string,
    count: number,
    sender?: TelegramReactionSnapshotEntry['sender'],
  ) => {
    const event = adaptReaction(reaction, emoji, count, sender);
    deps.eventSink.accept(event);
  };

  const reactionDebouncer = createReactionDebouncer(persistReactionEvent);

  const persistEmptyReactionSnapshotIfUnseeded = (chatId: string, messageId: string, updatedAtMs: number) => {
    const existing = deps.reactionStore.loadSnapshot(chatId, messageId);
    if (!existing) deps.reactionStore.upsertSnapshot(chatId, messageId, [], updatedAtMs);
  };

  const start = async () => {
    deps.manager.onMessage(msg => {
      if (msg.source === 'userbot' && msg.sender?.id === deps.botUserId) {
        try {
          deps.messageStore.persistMessage(msg);
          if (!msg.reactions || Object.keys(msg.reactions).length === 0)
            persistEmptyReactionSnapshotIfUnseeded(msg.chatId, String(msg.messageId), msg.receivedAtMs ?? Date.now());
        } catch (err) { deps.logger.withError(err).error('Failed to persist self message'); }
        return;
      }

      if (isServiceMessage(msg)) {
        const event = adaptServiceEvent(msg);
        if (event) {
          deps.logger.withFields({
            source: msg.source,
            chatId: msg.chatId,
            action: event.action.action,
          }).log('Service event received');

          deps.eventSink.accept(event, { notifyDriver: true });
        }
        return;
      }

      deps.logger.withFields({
        source: msg.source,
        chatId: msg.chatId,
        messageId: msg.messageId,
        sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
        text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
        length: msg.text.length,
      }).log('Message received');

      const event = adaptMessage(msg);
      if (deps.chatPolicy.isBlocked(event.chatId, event.sender?.id)) {
        const blockedEvent = deps.chatPolicy.toBlockedMessageEvent(event);
        deps.logger.withFields({ chatId: event.chatId, messageId: event.messageId }).debug('Redacted message from blocked user');
        deps.eventSink.accept(blockedEvent, { notifyDriver: true });
        return;
      }

      deps.eventSink.persist(event);

      try { deps.messageStore.persistMessage(msg); } catch (err) { deps.logger.withError(err).error('Failed to persist message'); }
      if (!msg.reactions || Object.keys(msg.reactions).length === 0)
        persistEmptyReactionSnapshotIfUnseeded(event.chatId, event.messageId, msg.receivedAtMs ?? Date.now());

      deps.eventSink.publish(event, { hydrateAltText: true, notifyDriver: true });
    });

    deps.manager.onMessageEdit(edit => {
      deps.logger.withFields({
        chatId: edit.chatId,
        messageId: edit.messageId,
        sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
        text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
        length: edit.text.length,
      }).log('Message edited');

      if (deps.chatPolicy.isBlocked(edit.chatId, edit.sender?.id)) {
        deps.logger.withFields({ chatId: edit.chatId, senderId: edit.sender?.id }).debug('Dropped edit from blocked user');
        return;
      }

      const event = adaptEdit(edit);
      const prev = deps.messageStore.loadLatestMessageContent(event.chatId, event.messageId);
      if (prev?.type === 'blocked_message') {
        deps.logger.withFields({ chatId: event.chatId, messageId: event.messageId }).debug('Dropped edit for blocked message');
        return;
      }
      if (prev) {
        const newText = contentToPlainText(event.content) || null;
        const newContent = event.content.length > 0 ? event.content : null;
        const newAttachments = event.attachments.length > 0 ? event.attachments : null;
        if (prev.text === newText
          && JSON.stringify(prev.content) === JSON.stringify(newContent)
          && JSON.stringify(prev.attachments) === JSON.stringify(newAttachments)) {
          return;
        }
      }

      deps.eventSink.persist(event);
      try { deps.messageStore.persistMessageEdit(edit); } catch (err) { deps.logger.withError(err).error('Failed to persist message edit'); }
      deps.eventSink.publish(event, { hydrateAltText: true, notifyDriver: true });
    });

    deps.manager.onMessageDelete(del => {
      deps.logger.withFields({ chatId: del.chatId ?? 'unknown', messageIds: del.messageIds }).log('Message deleted');

      const event = adaptDelete(del);
      deps.eventSink.persist(event);
      try { deps.messageStore.persistMessageDelete(del); } catch (err) { deps.logger.withError(err).error('Failed to persist message delete'); }
      deps.eventSink.publish(event, { notifyDriver: true });
    });

    deps.manager.onReactionUpdate(reaction => {
      deps.logger.withFields({
        chatId: reaction.chatId,
        messageId: reaction.messageId,
        kind: reaction.kind,
        reactions: reaction.kind === 'count' ? Object.keys(reaction.counts).length : reaction.newReactions.length,
      }).debug('Message reaction update received');

      const messageId = String(reaction.messageId);
      const previous = deps.reactionStore.loadSnapshot(reaction.chatId, messageId);
      const updatedAtMs = reaction.receivedAtMs ?? Date.now();

      if (reaction.kind === 'user') {
        const oldReactions = new Set(reaction.oldReactions);
        const newReactions = [...new Set(reaction.newReactions)];
        const newReactionSet = new Set(newReactions);
        const next = [
          ...(previous ?? []).filter(entry => entry.sender.id !== reaction.sender.id),
          ...newReactions.map(emoji => ({ emoji, sender: reaction.sender, date: reaction.date })),
        ];

        deps.reactionStore.upsertSnapshot(reaction.chatId, messageId, next, updatedAtMs);

        for (const emoji of oldReactions) {
          if (newReactionSet.has(emoji)) continue;
          reactionDebouncer.cancel(reaction.chatId, messageId, emoji, reaction.sender.id);
        }

        for (const emoji of newReactions) {
          if (oldReactions.has(emoji)) continue;
          if (deps.chatPolicy.isBlocked(reaction.chatId, reaction.sender.id)) continue;
          reactionDebouncer.enqueue(reaction, emoji, 1, reaction.sender);
        }
        return;
      }

      if (!reaction.snapshot) {
        deps.logger.withFields({ chatId: reaction.chatId, messageId: reaction.messageId }).debug('Reaction count update skipped because actor snapshot is unavailable');
        return;
      }

      deps.reactionStore.upsertSnapshot(reaction.chatId, messageId, reaction.snapshot, updatedAtMs);
      if (!previous) return;

      const oldKeys = new Set(previous.map(reactionEntryKey));
      const newKeys = new Set(reaction.snapshot.map(reactionEntryKey));
      for (const entry of previous) {
        if (newKeys.has(reactionEntryKey(entry))) continue;
        reactionDebouncer.cancel(reaction.chatId, messageId, entry.emoji, entry.sender.id);
      }

      for (const entry of reaction.snapshot) {
        if (oldKeys.has(reactionEntryKey(entry))) continue;
        if (deps.chatPolicy.isBlocked(reaction.chatId, entry.sender.id)) continue;
        reactionDebouncer.enqueue(reaction, entry.emoji, 1, entry.sender);
      }
    });

    deps.manager.onTyping(event => {
      if (event.userId === deps.botUserId) return;
      deps.driverControl.handleTyping(event.chatId, event.userId);
    });

    deps.manager.bot.registerCommand('offline', 'Pause automatic responses (only respond to @mentions and replies)', async chatId => {
      deps.driverControl.setOfflineMode(chatId, true);
      await deps.manager.bot.sendMessage(chatId, 'Offline mode enabled. I will only respond when @mentioned or replied to, then automatically return online.');
    });

    deps.manager.bot.registerCommand('online', 'Resume automatic responses', async chatId => {
      deps.driverControl.setOfflineMode(chatId, false);
      await deps.manager.bot.sendMessage(chatId, 'Online mode enabled.');
    });

    await deps.manager.start();
  };

  return { start };
};
