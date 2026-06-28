import { resolveChatConfig } from '../../config/config';
import { loadMessageAttachments } from '../../db';
import { createTelegramDriverHooks } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramDriverHooks({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_DRIVER_HOOKS, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) throw new Error('Telegram driver hooks requested without Telegram configured');
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    return createTelegramDriverHooks({
      manager,
      runtimeConfig: get(TOKENS.RUNTIME_CONFIG),
      logger: get(TOKENS.LOGGER),
      botUserId: get(TOKENS.RENDER_PARAMS).botUserId ?? '0',
      eventSink: get(TOKENS.TELEGRAM_EVENT_SINK),
      reactionStore: get(TOKENS.TELEGRAM_REACTION_STORE),
      loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
      getIntermediateContext: chatId => pipeline.getIC(chatId),
      resolveChatPlatform: id => resolveChatConfig(config, id).platform,
    });
  });
}
