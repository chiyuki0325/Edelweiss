import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

export interface SkillInfo {
  /** Stable skill id used by load_skill. Always derived from file or folder name. */
  name: string;
  /** Human-facing display title. Only CustomSkillsV2 exposes this in the system catalog. */
  title?: string;
  description?: string;
  usage?: string;
  format: 'custom' | 'custom-v2' | 'anthropic';
  content: string;
  resourceFiles?: string[];
}

const extractTitle = (content: string, fallback: string): string => {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1]!.trim() : fallback;
};

interface FrontMatterData {
  name: string;
  description: string;
  usage?: string;
}

interface ParsedFrontMatter {
  data: FrontMatterData;
  body: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const ANTHROPIC_SKILL_FILE = 'SKILL.md';

const parseFrontMatterSkill = (content: string): ParsedFrontMatter | null => {
  const match = content.match(FRONT_MATTER_RE);
  if (!match) return null;

  let rawData: unknown;
  try {
    rawData = parseYaml(match[1]!);
  } catch {
    return null;
  }
  if (typeof rawData !== 'object' || rawData === null) return null;

  const data = rawData as Record<string, unknown>;
  if (typeof data.name !== 'string' || data.name.trim() === '') return null;
  if (typeof data.description !== 'string' || data.description.trim() === '') return null;
  if (data.usage != null && typeof data.usage !== 'string') return null;

  return {
    data: {
      name: data.name.trim(),
      description: data.description.trim(),
      ...(typeof data.usage === 'string' && data.usage.trim() !== '' ? { usage: data.usage.trim() } : {}),
    },
    body: match[2]!.trimStart(),
  };
};

const loadMarkdownSkill = (path: string, id: string): SkillInfo | null => {
  const content = readFileSync(path, 'utf-8');
  const parsed = parseFrontMatterSkill(content);
  if (parsed) {
    return {
      name: id,
      title: parsed.data.name,
      description: parsed.data.description,
      ...(parsed.data.usage ? { usage: parsed.data.usage } : {}),
      format: 'custom-v2',
      content: parsed.body,
    };
  }
  if (FRONT_MATTER_RE.test(content)) return null;

  return {
    name: id,
    description: extractTitle(content, id),
    format: 'custom',
    content,
  };
};

const listResourceFiles = (root: string, skillFile: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, path);
      if (rel === skillFile) continue;
      files.push(resolve(path));
    }
  };
  walk(root);
  return files;
};

const loadAnthropicSkill = (path: string, id: string): SkillInfo | null => {
  const skillPath = join(path, ANTHROPIC_SKILL_FILE);
  let isFile = false;
  try {
    isFile = statSync(skillPath).isFile();
  } catch {
    return null;
  }
  if (!isFile) return null;

  const content = readFileSync(skillPath, 'utf-8');
  const parsed = parseFrontMatterSkill(content);
  if (!parsed) return null;

  const resourceFiles = listResourceFiles(path, ANTHROPIC_SKILL_FILE);
  return {
    name: id,
    description: parsed.data.description,
    ...(parsed.data.usage ? { usage: parsed.data.usage } : {}),
    format: 'anthropic',
    content: parsed.body,
    ...(resourceFiles.length > 0 ? { resourceFiles } : {}),
  };
};

export const loadSkillsFromFolder = (folder: string): Map<string, SkillInfo> => {
  const map = new Map<string, SkillInfo>();
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = basename(entry.name, '.md');
    const skill = loadMarkdownSkill(join(folder, entry.name), id);
    if (skill) map.set(id, skill);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const skill = loadAnthropicSkill(join(folder, entry.name), id);
    if (skill) map.set(id, skill);
  }
  return map;
};
