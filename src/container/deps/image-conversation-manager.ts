import { createImageConversationStore } from '../../db';
import { createImageConversationManager } from '../../media/image-conversation';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerImageConversationManager({ get, register }: Registrar): void {
  register(TOKENS.IMAGE_CONVERSATION_MANAGER, () => createImageConversationManager({
    store: createImageConversationStore(get(TOKENS.DB)),
    logger: get(TOKENS.LOGGER),
  }));
}
