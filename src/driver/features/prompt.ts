import { injectLateBindingPrompt, wasToolLoopInterrupted } from '../context';
import { renderLateBindingPrompt, renderSystemPrompt } from '../prompt';
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createPromptFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'prompt',
  preparePrompt: async ctx => {
    const { turn } = ctx;
    turn.system = await renderSystemPrompt({
      chatId: deps.chatId,
      chatName: await deps.getChatName(),
      currentChannel: deps.chatConfig.platform,
      modelName: deps.chatConfig.primaryModel.model,
      forceToolCall: deps.chatConfig.primaryModel.forceToolCall,
      systemFiles: deps.chatConfig.systemFiles,
      hasLoadSkillTool: deps.allSkills.size > 0,
      hasSubagentTools: deps.chatConfig.subagents.enabled,
      hasReactTool: deps.chatConfig.platform === 'telegram' && turn.reactionEmojis.length > 0,
      availableReactionEmojis: turn.reactionEmojis,
      availableSkills: [...deps.allSkills.values()]
        .map(s => ({
          id: s.name,
          ...(s.format === 'custom-v2' && s.title ? { title: s.title } : {}),
          description: s.description,
          usage: s.usage,
        })),
    });

    const isInterrupted = wasToolLoopInterrupted(turn.trs);
    const isMentioned = turn.rcAtStart.some(seg =>
      seg.mentionsMe && seg.receivedAtMs > deps.lastProcessedMs());
    const isReplied = turn.rcAtStart.some(seg =>
      seg.repliesToMe && seg.receivedAtMs > deps.lastProcessedMs());

    injectLateBindingPrompt(turn.entries, await renderLateBindingPrompt({
      timeNow: deps.nowString(),
      forceToolCall: deps.chatConfig.primaryModel.forceToolCall,
      isMentioned,
      isReplied,
      recentSendMessageHumanLikenessXml: ctx.scratch.recentSendMessageHumanLikenessXml,
      isInterrupted,
      activeBackgroundTasks: deps.getActiveBackgroundTasks(deps.chatId),
    }));
  },
});
