import type { loadLatestMessageContent, loadMessageReactionSnapshot, persistMessage, persistMessageDelete, persistMessageEdit } from '../db';
import type { TelegramReactionSnapshotEntry } from './message/types';

export interface TelegramReactionStore {
  loadSnapshot(chatId: string, messageId: string): ReturnType<typeof loadMessageReactionSnapshot>;
  upsertSnapshot(chatId: string, messageId: string, entries: TelegramReactionSnapshotEntry[], updatedAtMs: number): void;
}

export interface TelegramMessageStore {
  loadLatestMessageContent(chatId: string, messageId: string): ReturnType<typeof loadLatestMessageContent>;
  persistMessage(msg: Parameters<typeof persistMessage>[1]): void;
  persistMessageEdit(edit: Parameters<typeof persistMessageEdit>[1]): void;
  persistMessageDelete(del: Parameters<typeof persistMessageDelete>[1]): void;
}
