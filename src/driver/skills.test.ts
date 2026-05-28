import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSkillsFromFolder } from './skills';

const tempDirs: string[] = [];

const makeSkillsDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cahciua-skills-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadSkillsFromFolder', () => {
  it('loads legacy custom markdown skills using filename id and h1 display title', () => {
    const dir = makeSkillsDir();
    writeFileSync(join(dir, 'debug.md'), '# Debug Skill\n\nFind the failing path.');

    const skills = loadSkillsFromFolder(dir);

    expect(skills.get('debug')).toMatchObject({
      name: 'debug',
      description: 'Debug Skill',
      format: 'custom',
      content: '# Debug Skill\n\nFind the failing path.',
    });
  });

  it('loads front-matter custom v2 skills with filename id and front-matter display name', () => {
    const dir = makeSkillsDir();
    writeFileSync(join(dir, 'music.md'), [
      '---',
      'name: Music Helper',
      'description: Use for music search and lyrics lookup.',
      'usage: Load before answering music requests.',
      '---',
      '',
      'Follow the music workflow.',
    ].join('\n'));

    const skill = loadSkillsFromFolder(dir).get('music');

    expect(skill).toMatchObject({
      name: 'music',
      title: 'Music Helper',
      description: 'Use for music search and lyrics lookup.',
      usage: 'Load before answering music requests.',
      format: 'custom-v2',
      content: 'Follow the music workflow.',
    });
  });

  it('loads anthropic directory skills from SKILL.md and lists resource files', () => {
    const dir = makeSkillsDir();
    const skillDir = join(dir, 'browser-use');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Browser Use',
      'description: Use for browser automation tasks.',
      '---',
      '',
      'Inspect pages carefully.',
    ].join('\n'));
    writeFileSync(join(skillDir, 'README.md'), 'Extra docs');
    writeFileSync(join(skillDir, 'scripts', 'open.ts'), 'console.log("open");');

    const skill = loadSkillsFromFolder(dir).get('browser-use');

    expect(skill).toMatchObject({
      name: 'browser-use',
      description: 'Use for browser automation tasks.',
      format: 'anthropic',
      content: 'Inspect pages carefully.',
      resourceFiles: ['README.md', 'scripts/open.ts'],
    });
  });

  it('does not load directories without SKILL.md or invalid front-matter skills', () => {
    const dir = makeSkillsDir();
    mkdirSync(join(dir, 'missing-main'));
    writeFileSync(join(dir, 'invalid.md'), [
      '---',
      'name: Invalid',
      'description:',
      '  - not a string',
      '---',
      '',
      'Body',
    ].join('\n'));

    const skills = loadSkillsFromFolder(dir);

    expect(skills.has('missing-main')).toBe(false);
    expect(skills.has('invalid')).toBe(false);
  });

  it('prefers anthropic directory skills over same-id markdown files', () => {
    const dir = makeSkillsDir();
    writeFileSync(join(dir, 'debug.md'), '# Debug File\n\nFile body.');
    mkdirSync(join(dir, 'debug'));
    writeFileSync(join(dir, 'debug', 'SKILL.md'), [
      '---',
      'name: Debug Directory',
      'description: Directory wins.',
      '---',
      '',
      'Directory body.',
    ].join('\n'));

    expect(loadSkillsFromFolder(dir).get('debug')).toMatchObject({
      description: 'Directory wins.',
      format: 'anthropic',
    });
  });
});
