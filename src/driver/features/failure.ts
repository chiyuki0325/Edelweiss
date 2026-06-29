import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createFailureFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'failure',
  failTurn: (ctx, error) => {
    deps.log.withError(error).withFields({ 'chatId': ctx.turn.chatId }).error('LLM call failed');
    deps.schedulerController.markFailed(ctx.turn.rcAtStart);
  },
});
