import { getChatIds, resolveChatConfig } from '../../config/config';
import { loadKnownChatIds, lookupChatId } from '../../db';
import { selectTelegramIngressChatIds } from '../../startup/chat-selection';
import { createTelegramStartupManager } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegramManager({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM_MANAGER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const altText = get(TOKENS.ALT_TEXT_POLICY);
    const feature = get(TOKENS.FEATURE_SETS);
    const defaultChatConfig = resolveChatConfig(config, 'default');

    const chatIds = getChatIds(config);
    const knownChatIds = loadKnownChatIds(db);
    const telegramChatIds = chatIds.filter(id => resolveChatConfig(config, id).platform === 'telegram');
    const telegramIngressChatIds = selectTelegramIngressChatIds(knownChatIds, telegramChatIds);

    return createTelegramStartupManager({
      config,
      logger: get(TOKENS.LOGGER),
      telegramIngressChatIds,
      resolveChatId: messageIds => lookupChatId(db, messageIds),
      imageToTextChatIds: feature.imageToTextChatIds,
      imageToTextResolver: get(TOKENS.IMAGE_TO_TEXT_RESOLVER),
      animationToTextChatIds: feature.animationToTextChatIds,
      animationToTextResolver: get(TOKENS.ANIMATION_TO_TEXT_RESOLVER),
      customEmojiToTextChatIds: feature.customEmojiToTextChatIds,
      customEmojiToTextResolver: get(TOKENS.CUSTOM_EMOJI_RESOLVER),
      animationMaxFrames: defaultChatConfig.animationToText.maxFrames,
      getImageToTextCompression: altText.getImageToTextCompression,
    });
  });
}
