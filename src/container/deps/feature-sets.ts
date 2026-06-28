import { getChatIds, resolveChatConfig } from '../../config/config';
import type { Registrar } from '../registrar';
import type { FeatureSets } from '../tokens';
import { TOKENS } from '../tokens';

export default function registerFeatureSets({ get, register }: Registrar): void {
  register(TOKENS.FEATURE_SETS, (): FeatureSets => {
    const config = get(TOKENS.CONFIG);
    const chatIds = getChatIds(config);
    const defaultChatConfig = resolveChatConfig(config, 'default');

    const imageToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled));
    if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
      throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

    const animationToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).animationToText.enabled));
    if (animationToTextChatIds.size > 0 && !defaultChatConfig.animationToText.model)
      throw new Error('animationToText.model is required when animationToText.enabled=true (in chats.default or per-chat override)');

    const customEmojiToTextChatIds = new Set(chatIds.filter(id => resolveChatConfig(config, id).customEmojiToText.enabled));
    if (customEmojiToTextChatIds.size > 0 && !defaultChatConfig.customEmojiToText.model)
      throw new Error('customEmojiToText.model is required when customEmojiToText.enabled=true (in chats.default or per-chat override)');

    return { imageToTextChatIds, animationToTextChatIds, customEmojiToTextChatIds };
  });
}
