import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createLoggingFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'logging',
  preparePrompt: ctx => {
    deps.log.withFields({
      chatId: deps.chatId,
      entries: ctx.turn.entries.length,
      estimatedTokens: ctx.scratch.contextEstimatedTokens,
    }).log('Triggering LLM call');
  },
});
