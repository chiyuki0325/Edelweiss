import type { Logger } from '@guiiai/logg';

import { buildSendMessage } from './send';
import { createOneBotServer, type OneBotApiClient } from './server';
import type { RuntimeConfig } from '../config/config';
import type { PlatformAdapter } from '../driver/types';

export { adaptOneBotMessage, adaptOneBotNotice } from './adaptation';
export { lookupFace } from './face-config';
export { createOneBotServer };
export type { OneBotServer } from './server';
export type {
  OneBotApiResponse,
  OneBotEvent,
  OneBotMessageSegment,
} from './types';

export const createOneBotPlatformAdapter = (
  api: OneBotApiClient,
  runtime: RuntimeConfig,
  logger?: Logger,
): PlatformAdapter => ({
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
    return await api.sendMessage(chatId, segments);
  },
  downloadFile: async (identifier, chatId) =>
    await api.downloadFile(identifier, chatId),
  downloadImage: async (identifier, chatId) =>
    await api.downloadFile(identifier, chatId),
});
