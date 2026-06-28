import { loadMessageReactionSnapshot, upsertMessageReactionSnapshot } from '../../db';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramReactionStore({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_REACTION_STORE, () => {
    const db = get(TOKENS.DB);
    return {
      loadSnapshot: (chatId, messageId) => loadMessageReactionSnapshot(db, chatId, messageId),
      upsertSnapshot: (chatId, messageId, entries, updatedAtMs) => upsertMessageReactionSnapshot(db, chatId, messageId, entries, updatedAtMs),
    };
  });
}
