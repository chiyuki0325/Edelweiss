import { resolveChatConfig, resolveModel } from '../../config/config';
import { loadImageAltTextByHash, persistImageAltText } from '../../db';
import { createAnimationToTextResolver } from '../../media/animation-to-text';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerAnimationToTextResolver({ get, register }: Registrar): void {
  register(TOKENS.ANIMATION_TO_TEXT_RESOLVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const defaultChatConfig = resolveChatConfig(config, 'default');
    const semaphores = get(TOKENS.DESCRIPTION_SEMAPHORES);
    return createAnimationToTextResolver({
      enabled: get(TOKENS.FEATURE_SETS).animationToTextChatIds.size > 0,
      model: defaultChatConfig.animationToText.model ? resolveModel(config, defaultChatConfig.animationToText.model) : undefined,
      semaphore: semaphores.get(defaultChatConfig.animationToText.model),
      logger: get(TOKENS.LOGGER),
      lookupByHash: hash => loadImageAltTextByHash(db, hash),
      persist: record => persistImageAltText(db, record),
    });
  });
}
