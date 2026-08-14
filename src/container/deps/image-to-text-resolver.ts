import { resolveChatConfig, resolveModel } from '../../config/config';
import { loadImageAltTextByHash, persistImageAltText } from '../../db';
import { createImageToTextResolver } from '../../media/image-to-text';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerImageToTextResolver({ get, register }: Registrar): void {
  register(TOKENS.IMAGE_TO_TEXT_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    return createImageToTextResolver({
      enabled: get(TOKENS.FEATURE_SETS).imageToTextChatIds.size > 0,
      model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.imageToText.model),
      logger: get(TOKENS.LOGGER),
      lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
      persist: record => persistImageAltText(db, record),
      conversations: get(TOKENS.IMAGE_CONVERSATION_MANAGER),
    });
  });
}
