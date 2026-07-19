import type { SkillInfo } from '../skills';
import type { CahciuaTool } from './types';
import { createTool } from './types';

const stripDuplicateTitle = (title: string | undefined, content: string): string => {
  const trimmed = content.trim();
  if (!title) return trimmed;
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return trimmed.replace(new RegExp(`^#\\s+${escapedTitle}\\s*(?:\\r?\\n|$)`), '').trimStart();
};

const formatLoadedSkill = (skill: SkillInfo): string => {
  const sections = [`# ${skill.title ?? skill.name}`];
  if (skill.description) sections.push(`## Description\n\n${skill.description}`);
  if (skill.usage) sections.push(`## Usage\n\n${skill.usage}`);

  const body = stripDuplicateTitle(skill.title, skill.content);
  if (body) sections.push(body);

  if (skill.resourceFiles && skill.resourceFiles.length > 0) {
    sections.push(`## Resource files\n\n${skill.resourceFiles.map(file => `- ${file}`).join('\n')}`);
  }

  return sections.join('\n\n');
};

export const createLoadSkillTool = (
  availableSkills: () => Map<string, SkillInfo>,
  onSkillLoaded: (id: string) => void,
  isSkillLoaded: (id: string) => boolean = () => false,
): CahciuaTool => createTool({
  name: 'load_skill',
  execution: { lane: 'serial' },
  description: 'Load a predefined skill module into the current session. If the available skills list contains a skill that clearly matches the user request or next action, load it before giving a substantive answer or using other task-specific tools.',
  parameters: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'The id of the skill to load (as listed in the available skills section of the context).' },
    },
    required: ['skill_id'],
  },
  execute: input => {
    const { skill_id } = input as { skill_id: string };
    const skill = availableSkills().get(skill_id);
    if (!skill)
      return { content: JSON.stringify({ error: `Skill "${skill_id}" not found.` }), requiresFollowUp: true };
    if (isSkillLoaded(skill_id))
      return { content: JSON.stringify({ error: `Skill "${skill_id}" is already loaded in the current context window.` }), requiresFollowUp: true };
    onSkillLoaded(skill_id);
    return { content: formatLoadedSkill(skill), requiresFollowUp: true };
  },
});
