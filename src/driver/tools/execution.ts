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

export interface PreparedToolCall {
  id: string;
  name: string;
  input: unknown;
  tool: CahciuaTool;
}

export type PrepareToolCallResult =
  | { ok: true; call: PreparedToolCall }
  | { ok: false; result: IRToolResult };

/** Resolve, parse, and validate a tool call before scheduling it. */
export const prepareToolCall = (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): PrepareToolCallResult => {
  const tool = tools.find(t => t.function.name === name);
  if (!tool) return { ok: false, result: toolError(id, `Unknown tool: ${name}`) };

  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    log.withFields({ tool: name, args }).error('Tool call has invalid JSON args');
    return { ok: false, result: toolError(id, `Invalid JSON in tool arguments: ${args.slice(0, 200)}`) };
  }

  try {
    const { valid, errors } = tool.validate(input);
    if (!valid) {
      log.withFields({ tool: name, errors }).error('Tool call args failed schema validation');
      return { ok: false, result: toolError(id, `Arguments do not match schema: ${errors.join('; ')}`) };
    }
  } catch (err) {
    log.withError(err).error(`Tool ${name} validation failed`);
    return { ok: false, result: toolError(id, String(err)) };
  }

  return { ok: true, call: { id, name, input, tool } };
};

/** Execute an already validated tool call. Always resolves to a tool result. */
export const executePreparedToolCall = async (
  call: PreparedToolCall,
  log: Logger,
): Promise<IRToolResult> => {
  try {
    const rawResult = await call.tool.execute(call.input, { toolCallId: call.id });
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: JSON.stringify(rawResult), requiresFollowUp: true };
    return {
      kind: 'toolResult',
      callId: call.id,
      payload: content as string | InputPart[],
      requiresFollowUp,
    };
  } catch (err) {
    log.withError(err).error(`Tool ${call.name} failed`);
    return toolError(call.id, String(err));
  }
};

/** Execute a tool call against the tools list, returning an IR ToolResult. */
export const executeToolCall = async (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): Promise<IRToolResult> => {
  const prepared = prepareToolCall(id, name, args, tools, log);
  return prepared.ok ? await executePreparedToolCall(prepared.call, log) : prepared.result;
};
