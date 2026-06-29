import { createLoadSkillTool, extractLoadedSkillNames } from '../tools';
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createSkillFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'skill',
  prepareTools: ctx => {
    const { turn } = ctx;
    if (!turn.capabilities.canLoadSkill || deps.allSkills.size === 0) return;
    turn.loadedSkills = extractLoadedSkillNames(turn.entries);
    turn.tools.push(createLoadSkillTool(
      () => deps.allSkills,
      name => { turn.loadedSkills.add(name); },
      name => turn.loadedSkills.has(name),
    ));
  },
});
