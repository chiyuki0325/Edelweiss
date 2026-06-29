import { pruneLengthLimitFailures } from '../runner';
import type { DriverFeature } from '../turn-features';

export const createSendMessageFeature = (): DriverFeature => ({
  name: 'send-message',
  transformStepEntries: (ctx, entries) => {
    const { turn } = ctx;
    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, turn.pendingPrune);
    turn.pendingPrune = pendingPrune;
    return pruned;
  },
});
