import type { SkillInfo } from './skills';

export interface PseudoCommandContext {
  chatId: string;
  currentChannel: string;
  skillsFolder?: string;
  skills: Map<string, SkillInfo>;
}

export interface PseudoCommandResult {
  exitCode: number;
  output: string;
}

const shellWords = (command: string): string[] => {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(re)) {
    const doubleQuoted = match[1];
    const singleQuoted = match[2];
    const bare = match[3];
    if (doubleQuoted != null) {
      words.push(doubleQuoted.replace(/\\(["\\$`])/g, '$1'));
    } else if (singleQuoted != null) {
      words.push(singleQuoted);
    } else if (bare != null) {
      words.push(bare);
    }
  }
  return words;
};

const jsonOutput = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const catalogSkill = (skill: SkillInfo): Record<string, unknown> => ({
  id: skill.name,
  format: skill.format,
  ...(skill.format === 'custom-v2' && skill.title ? { title: skill.title } : {}),
  ...(skill.description ? { description: skill.description } : {}),
  ...(skill.usage ? { usage: skill.usage } : {}),
});

const fullSkillInfo = (skill: SkillInfo): Record<string, unknown> => ({
  ...catalogSkill(skill),
  ...(skill.skillsFolder ? { skillsFolder: skill.skillsFolder } : {}),
  ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
  ...(skill.mainFilePath ? { mainFilePath: skill.mainFilePath } : {}),
  resourceFiles: skill.resourceFiles ?? [],
});

export const executePseudoCommand = (
  command: string,
  context: PseudoCommandContext,
): PseudoCommandResult | null => {
  const argv = shellWords(command);
  const commandName = argv[0];
  if (commandName !== 'chat_info' && commandName !== 'skill_info') return null;

  if (commandName === 'chat_info') {
    if (argv.length > 1) {
      return {
        exitCode: 2,
        output: jsonOutput({ error: 'Usage: chat_info' }),
      };
    }
    return {
      exitCode: 0,
      output: jsonOutput({
        chatId: context.chatId,
        currentChannel: context.currentChannel,
        skillsFolder: context.skillsFolder ?? null,
      }),
    };
  }

  const skillId = argv[1];
  if (!skillId || argv.length > 2) {
    return {
      exitCode: 2,
      output: jsonOutput({ error: 'Usage: skill_info <skill_id>' }),
    };
  }

  const skill = context.skills.get(skillId);
  if (!skill) {
    return {
      exitCode: 1,
      output: jsonOutput({ error: `Skill "${skillId}" not found.` }),
    };
  }

  return {
    exitCode: 0,
    output: jsonOutput(fullSkillInfo(skill)),
  };
};
