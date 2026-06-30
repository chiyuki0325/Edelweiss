import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from './types';
import { isToolResult } from './types';
import type { ConversationEntry, InputPart, ToolCallPart, ToolResult as IRToolResult } from '../../unified-api/types';

/** Extract ToolCallParts from assistant OutputMessage entries. */
export const extractToolCalls = (entries: ConversationEntry[]): ToolCallPart[] => {
  const calls: ToolCallPart[] = [];
  for (const e of entries) {
    if (e.kind === 'message' && e.role === 'assistant') {
      for (const p of e.parts) if (p.kind === 'toolCall') calls.push(p);
    }
  }
  return calls;
};

export const extractLoadedSkillNames = (entries: ConversationEntry[]): Set<string> => {
  const result = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.kind !== 'message' || entry.role !== 'assistant') continue;

    for (const part of entry.parts) {
      if (part.kind !== 'toolCall' || part.name !== 'load_skill') continue;

      let skillId: string | undefined;
      try {
        const args = JSON.parse(part.args) as { skill_id?: unknown };
        if (typeof args.skill_id === 'string') skillId = args.skill_id;
      } catch {
        continue;
      }
      if (!skillId) continue;

      const isMatchingToolResult = (e: ConversationEntry): e is IRToolResult =>
        e.kind === 'toolResult' && e.callId === part.callId;
      const toolResult = entries.slice(i + 1).find(isMatchingToolResult);
      if (!toolResult || Array.isArray(toolResult.payload)) continue;
      if (toolResult.payload.startsWith('{')) continue;
      result.add(skillId);
    }
  }

  return result;
};

const toolError = (id: string, message: string): IRToolResult => ({
  kind: 'toolResult',
  callId: id,
  payload: JSON.stringify({ error: message }),
  requiresFollowUp: true,
});

/** Execute a tool call against the tools list, returning an IR ToolResult. */
export const executeToolCall = async (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): Promise<IRToolResult> => {
  const tool = tools.find(t => t.function.name === name);
  if (!tool) return toolError(id, `Unknown tool: ${name}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    log.withFields({ tool: name, args }).error('Tool call has invalid JSON args');
    return toolError(id, `Invalid JSON in tool arguments: ${args.slice(0, 200)}`);
  }

  const { valid, errors } = tool.validate(parsed);
  if (!valid) {
    log.withFields({ tool: name, errors }).error('Tool call args failed schema validation');
    return toolError(id, `Arguments do not match schema: ${errors.join('; ')}`);
  }

  try {
    const rawResult = await tool.execute(parsed, { toolCallId: id });
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: JSON.stringify(rawResult), requiresFollowUp: true };
    return {
      kind: 'toolResult',
      callId: id,
      payload: content as string | InputPart[],
      requiresFollowUp,
    };
  } catch (err) {
    log.withError(err).error(`Tool ${name} failed`);
    return toolError(id, String(err));
  }
};
