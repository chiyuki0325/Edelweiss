import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
};

export const createReactionFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'reaction',
  prepareCapabilities: async ctx => {
    const { turn, signal } = ctx;
    if (deps.chatConfig.platform !== 'telegram' || !deps.refreshAllowedReactionEmojis) return;
    try {
      turn.reactionEmojis = await abortable(deps.refreshAllowedReactionEmojis(deps.chatId, signal), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      deps.log.withError(err).withFields({ chatId: deps.chatId }).warn('Failed to refresh Telegram reaction emojis');
      turn.reactionEmojis = deps.getAllowedReactionEmojis?.(deps.chatId) ?? [];
    }
  },
});
