import { composeContext } from '../context';
import type { DriverFeature } from '../turn-features';
import { TurnPreparationSkipped } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createContextFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'context',
  prepareContext: async ctx => {
    const { turn } = ctx;
    const cursor = deps.cursorMs();
    const summary = deps.summary();
    const trs = await deps.loadTRs(deps.chatId, cursor);
    const composed = composeContext(
      turn.rcAtStart,
      trs,
      deps.chatConfig.compaction.maxContextEstTokens,
      turn.model.model,
      summary,
    );
    if (!composed) throw new TurnPreparationSkipped('No context entries to send');
    turn.trs = trs;
    turn.entries = composed.entries;
    ctx.scratch.contextEstimatedTokens = composed.estimatedTokens;
  },
});
