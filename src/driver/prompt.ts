import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');

// Strip Vue SSR artifacts (fragment markers, v-if placeholders),
// restore newline placeholders from template computed properties,
// unescape Velin's markdown escaping, and normalize whitespace.
const cleanVelinOutput = (raw: string): string =>
  raw
    .replace(/<!--\[-->/g, '')
    .replace(/<!--]-->/g, '')
    .replace(/<!--v-if-->/g, '')
    .replace(/<!---->/g, '')
    .replace(/\u200B/g, '\n')
    .replace(/\\`/g, '`')
    .replace(/\\_/g, '_')
    .replace(/^[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-system.velin.md'), 'utf-8');
const subagentSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/subagent-system.velin.md'), 'utf-8');
const lateBindingTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-late-binding.velin.md'), 'utf-8');
const compactionSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-system.velin.md'), 'utf-8');
const compactionUserTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-late-binding.velin.md'), 'utf-8');

export const renderSystemPrompt = async (params: {
  language?: string;
  modelName: string;
  currentChannel?: string;
  systemFiles?: { filename: string; content: string }[];
  hasLoadSkillTool?: boolean;
  hasSubagentTools?: boolean;
  availableSkills?: { name: string; title: string }[];
}) => {
  const publicParams = {
    language: params.language,
    modelName: params.modelName,
    currentChannel: params.currentChannel,
    hasLoadSkillTool: params.hasLoadSkillTool,
    hasSubagentTools: params.hasSubagentTools,
    availableSkills: params.availableSkills,
  };
  const systemFiles = params.systemFiles ?? [];
  for (const f of systemFiles) {
    if (f.filename.endsWith('.velin.md')) {
      f.filename = f.filename.replace('.velin.md', '.md');
      f.content = await renderMarkdownString(f.content, publicParams, basePath).then(r => cleanVelinOutput(r.rendered));
    }
  }
  let { rendered } = await renderMarkdownString(systemPromptTemplate, { ...publicParams, systemFiles }, basePath);
  rendered = cleanVelinOutput(rendered);
  // dirty hack workaround for velin wiping newlines inside templates
  for (const f of systemFiles) {
    const placeholder = `SYSTEM_FILE_${f.filename}`;
    rendered = rendered.replaceAll(placeholder, f.content);
  }
  return rendered;
};

export const renderSubagentSystemPrompt = async (params: {
  language?: string;
  modelName: string;
  task: string;
  context?: string;
  expectedOutput?: string;
}) => {
  const { rendered } = await renderMarkdownString(subagentSystemTemplate, params, basePath);
  return cleanVelinOutput(rendered);
};

export const renderLateBindingPrompt = async (params: {
  timeNow: string;
  isProbeEnabled?: boolean;
  isProbing?: boolean;
  isMentioned?: boolean;
  isReplied?: boolean;
  recentSendMessageHumanLikenessXml?: string;
  activeBackgroundTasks?: { id: number; typeName: string; intention?: string; liveSummary: string; startedMs: number; timeoutMs: number }[];
  isInterrupted?: boolean;
}) => {
  const { rendered } = await renderMarkdownString(lateBindingTemplate, params, basePath);
  return cleanVelinOutput(rendered);
};

export const renderCompactionSystemPrompt = async () => {
  const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath);
  return cleanVelinOutput(rendered);
};

export const renderCompactionUserInstruction = async () => {
  const { rendered } = await renderMarkdownString(compactionUserTemplate, {}, basePath);
  return cleanVelinOutput(rendered);
};
