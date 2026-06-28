import { loadLatestMessageContent, persistMessage, persistMessageDelete, persistMessageEdit } from '../../db';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramMessageStore({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_MESSAGE_STORE, () => {
    const db = get(TOKENS.DB);
    return {
      loadLatestMessageContent: (chatId, messageId) => loadLatestMessageContent(db, chatId, messageId),
      persistMessage: msg => persistMessage(db, msg),
      persistMessageEdit: edit => persistMessageEdit(db, edit),
      persistMessageDelete: del => persistMessageDelete(db, del),
    };
  });
}
