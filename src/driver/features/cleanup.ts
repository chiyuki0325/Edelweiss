import { wasToolLoopInterrupted } from '../context';
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createCleanupFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'cleanup',
  cleanupTurn: async ctx => {
    const { turn } = ctx;
    // 中断信息在运行状态释放前刷新，下一次调度读取的是完整 Turn 结果。
    try {
      const trs = await deps.loadTRs(deps.chatId, deps.cursorMs());
      deps.lastTRInterrupted(wasToolLoopInterrupted(trs));
    } catch (err) {
      deps.log.withError(err).withFields({ chatId: deps.chatId }).warn('Failed to refresh lastTRInterrupted');
    }
    turn.scope.activeTurn = null;
    if (deps.schedulerController.finishTurn(turn.abortController, ctx.completedNormally)) {
      deps.log.withFields({ chatId: deps.chatId }).log('Offline mode: auto-returning to online after response');
    }
  },
});
