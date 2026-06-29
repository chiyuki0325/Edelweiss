import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createCapabilityFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'capability',
  prepareCapabilities: ctx => {
    const { turn } = ctx;
    turn.capabilities.canReact = deps.chatConfig.platform === 'telegram' && turn.reactionEmojis.length > 0;
    turn.capabilities.canStartSubagent = deps.chatConfig.subagents.enabled;
    turn.capabilities.canMessageSubagent = deps.chatConfig.subagents.enabled;
  },
});
