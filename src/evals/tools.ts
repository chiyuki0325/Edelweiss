import type { EvalCapturedMessage, EvalToolName, EvalToolTrace } from './types';
import { loadSkillsFromFolder } from '../driver/skills';
import { createDismissMessageTool, createLoadSkillTool, createSendMessageTool } from '../driver/tools';
import type { CahciuaTool, SendMessageAttachment } from '../driver/tools';

export interface EvalToolsOptions {
  skillsFolder?: string;
  enabledTools?: EvalToolName[];
}

export interface EvalTools {
  tools: CahciuaTool[];
  trace: EvalToolTrace;
}

const defaultEnabledTools = (skillsFolder: string | undefined): EvalToolName[] =>
  skillsFolder ? ['send_message', 'dismiss_message', 'load_skill'] : ['send_message', 'dismiss_message'];

export const createEvalTools = (options: EvalToolsOptions = {}): EvalTools => {
  const enabledTools = new Set(options.enabledTools ?? defaultEnabledTools(options.skillsFolder));
  const trace: EvalToolTrace = {
    loadedSkills: [],
    sentMessages: [],
  };
  const tools: CahciuaTool[] = [];

  if (enabledTools.has('send_message')) {
    tools.push(createSendMessageTool(async (
      text: string,
      replyTo?: string,
      attachments?: SendMessageAttachment[],
    ): Promise<{ messageId: string }> => {
      const messageId = `eval-${trace.sentMessages.length + 1}`;
      const message: EvalCapturedMessage = {
        messageId,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(attachments ? { attachments } : {}),
      };
      trace.sentMessages.push(message);
      return { messageId };
    }));
  }

  if (enabledTools.has('dismiss_message'))
    tools.push(createDismissMessageTool());

  if (enabledTools.has('load_skill') && options.skillsFolder) {
    const skills = loadSkillsFromFolder(options.skillsFolder);
    tools.push(createLoadSkillTool(
      () => skills,
      name => { trace.loadedSkills.push(name); },
    ));
  }

  return { tools, trace };
};
