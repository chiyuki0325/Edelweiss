import type { Logger } from '@guiiai/logg';

import { buildOneBotSelfSentEvent } from './adaptation';
import { buildSendMessage } from './send';
import { createOneBotServer, type OneBotApiClient } from './server';
import type { RuntimeConfig } from '../config/config';
import type { PlatformAdapter } from '../driver/types';
import type { PipelineEvent } from '../pipeline';

export { adaptOneBotMessage, adaptOneBotNotice, buildOneBotSelfSentEvent } from './adaptation';
export { lookupFace } from './face-config';
export { createOneBotServer };
export type { OneBotServer } from './server';
export type {
  OneBotApiResponse,
  OneBotEvent,
  OneBotMessageSegment,
} from './types';

// Side-effect sink for the bot's own outbound messages. Mirrors the Telegram
// self-sent ordering (persist → hydrate → push to Pipeline) without notifying
// the Driver — see CLAUDE.md §isSelfSent Pipeline and the Telegram event-sink
// ordering constraints.
export interface OneBotSelfSentSink {
  getSelfId: () => string | null;
  persistEvent: (event: PipelineEvent) => void;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => void;
}

export interface OneBotPlatformAdapterDeps {
  api: OneBotApiClient;
  runtime: RuntimeConfig;
  logger?: Logger;
  selfSentSink?: OneBotSelfSentSink;
}

export const createOneBotPlatformAdapter = (deps: OneBotPlatformAdapterDeps): PlatformAdapter => {
  const { api, runtime, logger, selfSentSink } = deps;

  const injectSelfSentEvent = (
    chatId: string,
    messageId: string,
    text: string,
    replyToMessageId?: string,
  ) => {
    if (!selfSentSink) return;
    const selfId = selfSentSink.getSelfId();
    if (!selfId) {
      logger?.withContext('onebot:send').withFields({ chatId, messageId })
        .warn('Skipping self-sent event injection: OneBot self id unavailable');
      return;
    }
    const event = buildOneBotSelfSentEvent({ chatId, messageId, selfId, text, replyToMessageId });
    // Ordering mirrors Telegram's self-sent path: persist the canonical event,
    // hydrate cached alt text, push into the Pipeline. Do NOT notify the Driver
    // — the bot must not wake itself on its own message.
    selfSentSink.persistEvent(event);
    selfSentSink.hydrateAltTextFromCache(event);
    selfSentSink.pushPipelineEvent(chatId, event);
  };

  return {
    kind: 'onebot',
    sendMessage: async (chatId, text, options) => {
      const segments = await buildSendMessage(runtime, text, {
        replyTo: options?.replyTo,
        attachments: options?.attachments?.map(a => ({
          type: a.type,
          path: a.path,
          file_name: a.file_name,
        })),
        logger: logger?.withContext('onebot:send'),
      });
      const sent = await api.sendMessage(chatId, segments);
      injectSelfSentEvent(chatId, sent.messageId, text, options?.replyTo);
      return sent;
    },
    downloadFile: async (identifier, chatId) =>
      await api.downloadFile(identifier, chatId),
    downloadImage: async (identifier, chatId) =>
      await api.downloadFile(identifier, chatId),
  };
};
