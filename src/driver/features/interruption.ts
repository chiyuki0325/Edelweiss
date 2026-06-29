import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createInterruptionFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'interruption',
  shouldContinue: (ctx, step) => {
    const { turn } = ctx;
    if (!step.hasToolCalls || !step.anyRequiresFollowUp) return undefined;
    if (deps.rc() === turn.rcAtStart) return undefined;

    const hasPendingRuntimeEvent = deps.rc().some(seg =>
      seg.receivedAtMs > deps.lastProcessedMs() && !seg.isMyself && !!seg.isRuntimeEvent);
    if (!hasPendingRuntimeEvent) return undefined;

    deps.log.withFields({ chatId: deps.chatId, step: turn.step }).log('Turn stopped at step boundary for runtime event');
    return false;
  },
});
