import type { Logger } from '@guiiai/logg';
import type { ToolMessage } from '@langchain/core/messages';
import { isAIMessage, isToolMessage } from '@langchain/core/messages';

import type { CahciuaTool } from './types';
import { isToolResult } from './types';
import type { ConversationEntry as LegacyConversationEntry } from '../../unified-api/types';
import {
  legacyEntriesToMessages,
  toolCalls,
  toolMessage,
  type DriverMessage,
  type DriverToolCall,
  type DriverToolMessage,
} from '../messages';

export const extractToolCalls = (entries: DriverMessage[]): DriverToolCall[] => toolCalls(entries);

export const extractLoadedSkillNames = (
  sourceEntries: DriverMessage[] | LegacyConversationEntry[],
): Set<string> => {
  const entries = sourceEntries.length > 0 && 'kind' in sourceEntries[0]!
    ? legacyEntriesToMessages(sourceEntries as LegacyConversationEntry[])
    : sourceEntries as DriverMessage[];
  const result = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !isAIMessage(entry)) continue;

    for (const call of entry.tool_calls ?? []) {
      if (call.name !== 'load_skill') continue;

      let skillId: string | undefined;
      const args = call.args as { skill_id?: unknown };
      if (typeof args.skill_id === 'string') skillId = args.skill_id;
      if (!skillId) continue;

      const isMatchingToolResult = (e: DriverMessage): e is ToolMessage =>
        isToolMessage(e) && e.tool_call_id === call.id;
      const toolResult = entries.slice(i + 1).find(isMatchingToolResult);
      if (!toolResult || typeof toolResult.content !== 'string') continue;
      if (toolResult.content.startsWith('{')) continue;
      result.add(skillId);
    }
  }

  return result;
};

const toolError = (id: string, message: string): DriverToolMessage =>
  toolMessage(id, JSON.stringify({ error: message }), true);

export interface PreparedToolCall {
  id: string;
  name: string;
  input: unknown;
  tool: CahciuaTool;
}

export type PrepareToolCallResult =
  | { ok: true; call: PreparedToolCall }
  | { ok: false; result: DriverToolMessage };

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
): Promise<DriverToolMessage> => {
  try {
    const rawResult = await call.tool.execute(call.input, { toolCallId: call.id });
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: JSON.stringify(rawResult), requiresFollowUp: true };
    return toolMessage(call.id, content, requiresFollowUp);
  } catch (err) {
    log.withError(err).error(`Tool ${call.name} failed`);
    return toolError(call.id, String(err));
  }
};

/** Execute a tool call against the tools list, returning an IR ToolResult. */
export const executeToolCall = async (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): Promise<DriverToolMessage> => {
  const prepared = prepareToolCall(id, name, args, tools, log);
  return prepared.ok ? await executePreparedToolCall(prepared.call, log) : prepared.result;
};
