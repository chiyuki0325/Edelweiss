import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createCleanupFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'cleanup',
  cleanupTurn: ctx => {
    const { turn } = ctx;
    deps.schedulerController.onTurnSettled();
    deps.schedulerController.clearAbortController(turn.abortController);
    turn.scope.activeTurn = null;
    deps.running(false);
    if (turn.flags.wasOfflineAtStart) {
      deps.offline(false);
      deps.log.withFields({ chatId: deps.chatId }).log('Offline mode: auto-returning to online after response');
    }
  },
});
