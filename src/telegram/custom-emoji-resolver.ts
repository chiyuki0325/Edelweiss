import type { Logger } from '@guiiai/logg';

import { createCustomEmojiToTextResolver } from '../media';
import type { CustomEmojiToTextResolver } from '../media';
import type { TelegramManager } from './manager';

export const createTelegramCustomEmojiResolver = (deps: {
  enabled: boolean;
  model: Parameters<typeof createCustomEmojiToTextResolver>[0]['model'];
  semaphore: Parameters<typeof createCustomEmojiToTextResolver>[0]['semaphore'];
  maxFrames: number;
  logger: Logger;
  lookupByHash: Parameters<typeof createCustomEmojiToTextResolver>[0]['lookupByHash'];
  persist: Parameters<typeof createCustomEmojiToTextResolver>[0]['persist'];
  managerRef: { telegram?: TelegramManager };
}): CustomEmojiToTextResolver => createCustomEmojiToTextResolver({
  enabled: deps.enabled,
  model: deps.model,
  semaphore: deps.semaphore,
  maxFrames: deps.maxFrames,
  logger: deps.logger,
  lookupByHash: deps.lookupByHash,
  persist: deps.persist,
  getCustomEmojiStickers: async ids => {
    const bot = deps.managerRef.telegram!.bot.raw();
    return await bot.api.getCustomEmojiStickers(ids);
  },
  downloadFile: async fileId => await deps.managerRef.telegram!.bot.downloadFile(fileId),
  resolvePackTitle: async setName => await deps.managerRef.telegram!.resolvePackTitle(setName),
});
