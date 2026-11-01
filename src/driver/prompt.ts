import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

import type { ToolChoice } from '../llm/tool-choice';
import { cleanVelinOutput, renderPromptTemplate } from '../prompt-template';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');

const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-system.velin.md'), 'utf-8');
const subagentSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/subagent-system.velin.md'), 'utf-8');
const lateBindingTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-late-binding.velin.md'), 'utf-8');
const compactionUserTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-late-binding.velin.md'), 'utf-8');

export interface AvailableSkillPromptInfo {
  id: string;
  title?: string;
  description?: string;
  usage?: string;
}

export interface SystemPromptParams {
  chatId: string;
  chatName: string;
  identityName: string;
  language?: string;
  modelName: string;
  currentChannel?: string;
  systemFiles?: { filename: string; content: string }[];
  hasLoadSkillTool?: boolean;
  hasSubagentTools?: boolean;
  hasReactTool?: boolean;
  hasAskForImageTool?: boolean;
  hasAdvancedImApiTool?: boolean;
  availableReactionEmojis?: string[];
  availableSkills?: AvailableSkillPromptInfo[];
  toolChoice?: ToolChoice;
}

export const renderSystemPrompt = async (params: SystemPromptParams) => {
  return await renderPromptTemplate(systemPromptTemplate, {
    chatId: params.chatId.replace(/\s+/g, ' ').trim(),
    chatName: params.chatName.replace(/\s+/g, ' ').trim(),
    identityName: params.identityName.replace(/\s+/g, ' ').trim(),
    language: params.language,
    modelName: params.modelName,
    currentChannel: params.currentChannel,
    hasLoadSkillTool: params.hasLoadSkillTool,
    hasSubagentTools: params.hasSubagentTools,
    hasReactTool: params.hasReactTool,
    hasAskForImageTool: params.hasAskForImageTool,
    hasAdvancedImApiTool: params.hasAdvancedImApiTool,
    availableReactionEmojis: params.availableReactionEmojis,
    availableSkills: params.availableSkills,
    toolChoice: params.toolChoice,
    systemFiles: params.systemFiles,
  }, basePath);
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
  isMentioned?: boolean;
  isReplied?: boolean;
  isAssociatedChannelPost?: boolean;
  recentSendMessageHumanLikenessXml?: string;
  activeBackgroundTasks?: { id: number; typeName: string; intention?: string; liveSummary: string; startedMs: number; timeoutMs: number }[];
  isInterrupted?: boolean;
  toolChoice?: ToolChoice;
}) => {
  const { rendered } = await renderMarkdownString(lateBindingTemplate, {
    ...params,
    toolChoice: params.toolChoice,
  }, basePath);
  return cleanVelinOutput(rendered);
};

export const renderCompactionUserInstruction = async () => {
  const { rendered } = await renderMarkdownString(compactionUserTemplate, {}, basePath);
  return cleanVelinOutput(rendered);
};
