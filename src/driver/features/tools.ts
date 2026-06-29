import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createToolFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'tools',
  prepareTools: ctx => {
    const { turn } = ctx;
    const sharedTools = deps.createCapabilityTools(
      turn.capabilities,
      turn.reactionEmojis,
      deps.createSendMessageTurnFlags(turn),
    );
    const subagentTools = turn.capabilities.canStartSubagent ? deps.subagentManager.mainTools() : [];
    turn.tools = [...sharedTools, ...subagentTools];
  },
});
