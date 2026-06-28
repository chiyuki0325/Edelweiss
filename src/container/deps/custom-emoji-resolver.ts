import { resolveChatConfig, resolveModel } from '../../config/config';
import { loadImageAltTextByHash, persistImageAltText } from '../../db';
import { createTelegramCustomEmojiResolver } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerCustomEmojiResolver({ get, register }: Registrar): void {
  register(TOKENS.CUSTOM_EMOJI_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    // managerRef is a lazy getter: it resolves TELEGRAM_MANAGER only when invoked at
    // runtime (after startup wiring completes), breaking the resolver↔telegram cycle.
    const managerRef = {
      get telegram() { return get(TOKENS.TELEGRAM_MANAGER); },
    };
    return createTelegramCustomEmojiResolver({
      enabled: get(TOKENS.FEATURE_SETS).customEmojiToTextChatIds.size > 0,
      model: defaultChatConfig.customEmojiToText.model ? resolveModel(config, defaultChatConfig.customEmojiToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.customEmojiToText.model),
      maxFrames: defaultChatConfig.customEmojiToText.maxFrames,
      logger: get(TOKENS.LOGGER),
      lookupByHash: hash => loadImageAltTextByHash(db, hash),
      persist: record => persistImageAltText(db, record),
      managerRef,
    });
  });
}
