import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SkillInfo } from './skills';
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
      skillsFolder: dir,
      skillPath: join(dir, 'debug.md'),
      mainFilePath: join(dir, 'debug.md'),
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
      skillsFolder: dir,
      skillPath: join(dir, 'music.md'),
      mainFilePath: join(dir, 'music.md'),
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
      skillsFolder: dir,
      skillPath: skillDir,
      mainFilePath: join(skillDir, 'SKILL.md'),
      resourceFiles: [join(skillDir, 'README.md'), join(skillDir, 'scripts', 'open.ts')],
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

  describe('project skills/', () => {
    const projectSkillsDir = resolve('skills');

    const dumpSkill = (s: SkillInfo | undefined, label: string) => {
      if (!s) {
        console.log(`  [${label}] => undefined (not loaded)`);
        return;
      }
      console.log(`  [${label}] name=${s.name} title=${s.title ?? '<none>'} format=${s.format} desc=${s.description?.slice(0, 80)}...`);
    };

    it('loads skill-authoring.md as custom-v2', () => {
      const all = loadSkillsFromFolder(projectSkillsDir);
      console.log(`Skills loaded from ${projectSkillsDir}: ${all.size} total`);
      for (const [id, s] of all) dumpSkill(s, id);

      const skill = all.get('skill-authoring');
      dumpSkill(skill, 'skill-authoring');

      expect(skill, 'skill-authoring must be loaded').toBeDefined();

      expect(skill!.name).toBe('skill-authoring');
      expect(skill!.title).toBe('Skill Authoring');
      expect(skill!.format).toBe('custom-v2');
      expect(skill!.description).toContain('inspect the current chat/skill environment');
      expect(skill!.usage).toContain('Load this before creating');
      expect(skill!.content).toContain('Skills are reusable workflow notes');
      expect(skill!.skillsFolder).toBe(projectSkillsDir);
      expect(skill!.skillPath).toBe(join(projectSkillsDir, 'skill-authoring.md'));
      expect(skill!.mainFilePath).toBe(join(projectSkillsDir, 'skill-authoring.md'));
    });

    it('front-matter parse: rejects when name is empty', () => {
      const dir = makeSkillsDir();
      writeFileSync(join(dir, 'bad-name.md'), [
        '---',
        'name: ""',
        'description: Has description',
        '---',
        '',
        'Body',
      ].join('\n'));

      expect(loadSkillsFromFolder(dir).has('bad-name')).toBe(false);
    });

    it('front-matter parse: rejects when description is not a string', () => {
      const dir = makeSkillsDir();
      writeFileSync(join(dir, 'bad-desc.md'), [
        '---',
        'name: Good Name',
        'description:',
        '  - not a string',
        '---',
        '',
        'Body',
      ].join('\n'));

      expect(loadSkillsFromFolder(dir).has('bad-desc')).toBe(false);
    });

    it('front-matter parse: rejects when description is empty string', () => {
      const dir = makeSkillsDir();
      writeFileSync(join(dir, 'empty-desc.md'), [
        '---',
        'name: Good Name',
        'description: ""',
        '---',
        '',
        'Body',
      ].join('\n'));

      expect(loadSkillsFromFolder(dir).has('empty-desc')).toBe(false);
    });

    it('front-matter parse: rejects when usage is non-string', () => {
      const dir = makeSkillsDir();
      writeFileSync(join(dir, 'bad-usage.md'), [
        '---',
        'name: Good Name',
        'description: Good description',
        'usage:',
        '  key: value',
        '---',
        '',
        'Body',
      ].join('\n'));

      expect(loadSkillsFromFolder(dir).has('bad-usage')).toBe(false);
    });

    it('front-matter parse: body starts after front-matter (no leading empty line bleed)', () => {
      const dir = makeSkillsDir();
      writeFileSync(join(dir, 'body-test.md'), [
        '---',
        'name: Body Test',
        'description: Testing body extraction',
        '---',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
      ].join('\n'));

      const skill = loadSkillsFromFolder(dir).get('body-test');
      expect(skill).toBeDefined();
      // body must NOT start with a blank line — trimStart in parseFrontMatterSkill handles this
      expect(skill!.content).toMatch(/^First paragraph/);
    });

    it('returns empty map and logs warning when folder is not accessible', () => {
      const nonexistent = join(tmpdir(), `does-not-exist-skills-${  Date.now()}`);
      const log = { warn: vi.fn(), withFields: vi.fn(), withError: vi.fn() } as any;
      log.withFields.mockReturnValue(log);
      log.withError.mockReturnValue(log);

      const skills = loadSkillsFromFolder(nonexistent, { log });

      expect(skills.size).toBe(0);
      expect(log.withError).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot read skills folder'));
    });

    it('returns empty map without crashing when logger is not provided and folder is missing', () => {
      const nonexistent = join(tmpdir(), `also-does-not-exist-${  Date.now()}`);
      const skills = loadSkillsFromFolder(nonexistent);
      expect(skills.size).toBe(0);
    });
  });
});
