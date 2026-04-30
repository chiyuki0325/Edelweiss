import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface SkillInfo {
  name: string;
  title: string;
  content: string;
}

const extractTitle = (content: string, fallback: string): string => {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1]!.trim() : fallback;
};

export const loadSkillsFromFolder = (folder: string): Map<string, SkillInfo> => {
  const map = new Map<string, SkillInfo>();
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return map;
  }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const name = basename(file, '.md');
    const content = readFileSync(join(folder, file), 'utf-8');
    map.set(name, { name, title: extractTitle(content, name), content });
  }
  return map;
};
