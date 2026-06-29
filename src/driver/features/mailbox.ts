import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createMailboxFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'mailbox',
  beforeStep: ctx => {
    const externalEntries = deps.mailbox.flush('main');
    if (externalEntries.length > 0)
      ctx.turn.entries = [...ctx.turn.entries, ...externalEntries];
  },
});
