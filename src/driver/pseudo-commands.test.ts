import { describe, expect, it } from 'vitest';

import { executePseudoCommand } from './tools/bash';
import type { SkillInfo } from './skills';

const skills = new Map<string, SkillInfo>([
  ['debug', {
    name: 'debug',
    format: 'custom-v2',
    title: 'Debug Skill',
    description: 'Use for debugging.',
    usage: 'Call before inspecting failures.',
    content: 'Debug instructions.',
    skillsFolder: '/repo/skills',
    skillPath: '/repo/skills/debug.md',
    mainFilePath: '/repo/skills/debug.md',
  }],
  ['browser-use', {
    name: 'browser-use',
    format: 'anthropic',
    description: 'Use for browser automation.',
    content: 'Browser instructions.',
    skillsFolder: '/repo/skills',
    skillPath: '/repo/skills/browser-use',
    mainFilePath: '/repo/skills/browser-use/SKILL.md',
    resourceFiles: ['/repo/skills/browser-use/README.md'],
  }],
]);

describe('executePseudoCommand', () => {
  const context = {
    chatId: 'chat-1',
    currentChannel: 'telegram',
    skillsFolder: '/repo/skills',
    skills,
  };

  it('returns null for ordinary shell commands', () => {
    expect(executePseudoCommand('echo hello', context)).toBeNull();
  });

  it('returns chat id, channel, and skills folder for chat_info', () => {
    const result = executePseudoCommand('chat_info', context);

    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result!.output)).toEqual({
      chatId: 'chat-1',
      currentChannel: 'telegram',
      skillsFolder: '/repo/skills',
    });
  });

  it('returns one skill detail for skill_info', () => {
    const result = executePseudoCommand('skill_info browser-use', context);

    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result!.output)).toEqual({
      id: 'browser-use',
      format: 'anthropic',
      description: 'Use for browser automation.',
      skillsFolder: '/repo/skills',
      skillPath: '/repo/skills/browser-use',
      mainFilePath: '/repo/skills/browser-use/SKILL.md',
      resourceFiles: ['/repo/skills/browser-use/README.md'],
    });
  });

  it('supports quoted skill ids and reports not found', () => {
    const result = executePseudoCommand('skill_info "missing skill"', context);

    expect(result?.exitCode).toBe(1);
    expect(JSON.parse(result!.output)).toEqual({
      error: 'Skill "missing skill" not found.',
    });
  });
});
