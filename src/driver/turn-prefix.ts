import type { SystemPromptParams } from './prompt';
import type { SkillInfo } from './skills';
import { createDefaultTurnCapabilities } from './turn-state';
import type { TurnCapabilities } from './turn-state';
import type { ResolvedChatConfig } from '../config/config';

/**
 * Capability set shared by a main turn and any call that must reuse its prompt
 * prefix (e.g. compaction). Mirrors the mutations the main-turn capability
 * feature applies on top of the default main capabilities.
 */
export const buildMainCapabilities = (
  chatConfig: ResolvedChatConfig,
  reactionEmojis: string[],
): TurnCapabilities => {
  const capabilities = createDefaultTurnCapabilities('main');
  capabilities.canReact = chatConfig.platform === 'telegram' && reactionEmojis.length > 0;
  capabilities.canStartSubagent = chatConfig.subagents.enabled;
  capabilities.canMessageSubagent = chatConfig.subagents.enabled;
  return capabilities;
};

/**
 * Build the exact `renderSystemPrompt` params a main turn uses, so callers that
 * need a byte-identical system prompt (prompt-cache prefix reuse) stay in sync.
 */
export const buildMainSystemPromptParams = (params: {
  chatId: string;
  chatName: string;
  chatConfig: ResolvedChatConfig;
  allSkills: Map<string, SkillInfo>;
  reactionEmojis: string[];
  capabilities: TurnCapabilities;
}): SystemPromptParams => ({
  chatId: params.chatId,
  chatName: params.chatName,
  identityName: params.chatConfig.identityName,
  currentChannel: params.chatConfig.platform,
  modelName: params.chatConfig.primaryModel.model,
  toolChoice: params.chatConfig.primaryModel.toolChoice,
  systemFiles: params.chatConfig.systemFiles,
  hasLoadSkillTool: params.allSkills.size > 0,
  hasSubagentTools: params.chatConfig.subagents.enabled,
  hasReactTool: params.chatConfig.platform === 'telegram' && params.reactionEmojis.length > 0,
  hasAskForImageTool: Boolean(params.chatConfig.imageToText.model && params.capabilities.canAskForImage),
  hasAdvancedImApiTool: params.capabilities.canUseAdvancedImApi,
  availableReactionEmojis: params.reactionEmojis,
  availableSkills: [...params.allSkills.values()]
    .map(s => ({
      id: s.name,
      ...(s.format === 'custom-v2' && s.title ? { title: s.title } : {}),
      description: s.description,
      usage: s.usage,
    })),
});
