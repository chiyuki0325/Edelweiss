import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createPersistenceFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'persistence',
  persistStep: async (ctx, step) => {
    await deps.persistTurnResponse(deps.chatId, {
      requestedAtMs: step.requestedAtMs,
      entries: step.persistedEntries,
      inputTokens: step.usage.inputTokens,
      outputTokens: step.usage.outputTokens,
      modelName: ctx.turn.model.model,
    });
    deps.lastProcessedMs(step.requestedAtMs);
  },
});
