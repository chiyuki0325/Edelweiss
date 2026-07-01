import { wasToolLoopInterrupted } from '../context';
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createCleanupFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'cleanup',
  cleanupTurn: async ctx => {
    const { turn } = ctx;
    // Refresh interrupted state before flipping running, so needsReply
    // recomputes with both signals settled atomically.
    try {
      const trs = await deps.loadTRs(deps.chatId, deps.cursorMs());
      deps.lastTRInterrupted(wasToolLoopInterrupted(trs));
    } catch (err) {
      deps.log.withError(err).withFields({ chatId: deps.chatId }).warn('Failed to refresh lastTRInterrupted');
    }
    deps.schedulerController.onTurnSettled();
    deps.schedulerController.clearAbortController(turn.abortController);
    turn.scope.activeTurn = null;
    deps.running(false);
    if (deps.focusMode()) deps.focusMode(false);
    if (turn.flags.wasOfflineAtStart) {
      deps.offline(false);
      deps.log.withFields({ chatId: deps.chatId }).log('Offline mode: auto-returning to online after response');
    }
  },
});
