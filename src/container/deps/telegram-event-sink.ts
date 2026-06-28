import { getChatIds } from '../../config/config';
import { persistEvent } from '../../db';
import { createTelegramEventSink } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramEventSink({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_EVENT_SINK, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const altText = get(TOKENS.ALT_TEXT_POLICY);
    return createTelegramEventSink({
      configuredChatIds: new Set(getChatIds(config)),
      persistEvent: event => persistEvent(db, event),
      hydrateAltTextFromCache: event => altText.hydrateAltTextFromCache(event),
      pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
      onDriverEvent: (chatId, rc) => get(TOKENS.DRIVER).handleEvent(chatId, rc),
    });
  });
}
