import type { Logger } from '@guiiai/logg';

import { callLlm, type LlmCallConfig, type ToolSchema } from './call-llm';
import { ensureDumpDir } from './constants';
import type { CahciuaTool } from './tools';
import { executeToolCall, extractToolCalls } from './tools';
import type { Usage } from './types';
import type {
  ConversationEntry,
  ToolResult,
} from '../unified-api/types';

ensureDumpDir();

const isLengthLimitFailure = (tr: ToolResult): boolean => {
  if (typeof tr.payload !== 'string') return false;
  try {
    const parsed = JSON.parse(tr.payload);
    return parsed.ok === false && typeof parsed.error === 'string' && parsed.error.includes('too long');
  } catch {
    return false;
  }
};

/**
 * Prune failed send_message tool calls caused by the 256-byte length limit,
 * plus the thinking content between the failure and the next successful send_message.
 *
 * This is a few-shot cleanup: the pruned entries are what gets persisted (future context
 * won't see the "try long → fail → split" pattern). The live working context within the
 * current turn is NOT pruned — the model needs to see its error to correct.
 */
export const pruneLengthLimitFailures = (
  entries: ConversationEntry[],
  pendingPrune: boolean,
): { pruned: ConversationEntry[]; pendingPrune: boolean } => {
  // Shallow-clone entries so we can mutate parts arrays safely.
  // ToolResults with string payloads and OutputMessages with OutputPart[] are safe
  // to shallow-clone — no Sharp objects in send_message results.
  const result = entries.map(e => {
    if (e.kind === 'message') {
      if (e.role === 'assistant') {
        return { ...e, parts: [...e.parts], reasoning: e.reasoning };
      }
      return { ...e, parts: [...e.parts] };
    }
    return { ...e };
  });

  let nextPendingPrune = pendingPrune;

  // Step 1: If a previous step had a length-limit failure, remove all thinking
  // (TextPart / ReasoningPart) that appears before the first send_message ToolCallPart
  // in this step. This is the "from failure to next successful send_message" gap.
  if (nextPendingPrune) {
    for (const entry of result) {
      if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
      const parts = entry.parts;
      const firstSendIdx = parts.findIndex(
        p => p.kind === 'toolCall' && p.name === 'send_message',
      );
      if (firstSendIdx !== -1) {
        entry.parts = parts.filter((p, i) => {
          if (i < firstSendIdx && (p.kind === 'text' || p.kind === 'reasoning'))
            return false;
          return true;
        });
        nextPendingPrune = false;
        break;
      }
    }
  }

  // Step 2: Find and remove length-limit failures.
  // Iterate in reverse so splice indices stay valid during removal.
  for (let i = result.length - 1; i >= 0; i--) {
    const entry = result[i]!;
    if (entry.kind !== 'toolResult') continue;
    if (!isLengthLimitFailure(entry)) continue;

    // Find the matching ToolCallPart in a preceding OutputMessage
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const e = result[j]!;
      if (e.kind !== 'message' || e.role !== 'assistant') continue;
      const parts = e.parts;
      const tcIdx = parts.findIndex(
        p => p.kind === 'toolCall' && p.callId === entry.callId && p.name === 'send_message',
      );
      if (tcIdx === -1) continue;

      // Remove the failed ToolCallPart
      parts.splice(tcIdx, 1);
      // Remove all thinking content from this OutputMessage
      e.parts = parts.filter(
        p => p.kind !== 'text' && p.kind !== 'reasoning',
      );
      // Clear message-level reasoning too
      e.reasoning = undefined;
      // Remove the ToolResult
      result.splice(i, 1);
      nextPendingPrune = true;
      found = true;
      break;
    }

    // If no matching ToolCallPart was found (orphaned ToolResult), still remove it
    if (!found) {
      result.splice(i, 1);
      nextPendingPrune = true;
    }
  }

  // Step 3: Clean up entries that became empty or orphaned after pruning
  const remainingCallIds = new Set<string>();
  for (const entry of result) {
    if (entry.kind === 'message' && entry.role === 'assistant') {
      for (const p of entry.parts) {
        if (p.kind === 'toolCall') remainingCallIds.add(p.callId);
      }
    }
  }

  const cleaned = result.filter(entry => {
    if (entry.kind === 'message' && entry.role === 'assistant' && entry.parts.length === 0 && !entry.reasoning)
      return false;
    if (entry.kind === 'toolResult' && !remainingCallIds.has(entry.callId))
      return false;
    return true;
  });

  return { pruned: cleaned, pendingPrune: nextPendingPrune };
};

export interface RunnerConfig extends LlmCallConfig {}

export interface StepLoopParams {
  chatId: string;
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  maxSteps: number;
  maxImagesAllowed?: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: Usage,
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
  pullExternalEntries?: () => ConversationEntry[] | Promise<ConversationEntry[]>;
  shouldStop?: () => boolean;
  signal?: AbortSignal;
  log: Logger;
}

const toToolSchema = (t: CahciuaTool): ToolSchema => ({
  name: t.function.name,
  parameters: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

export const createRunner = (config: RunnerConfig) => {
  const runOneStep = async (
    workingEntries: ConversationEntry[],
    params: StepLoopParams,
    step: number,
  ): Promise<{
    stepEntries: ConversationEntry[];
    usage: Usage;
    requestedAtMs: number;
    hasToolCalls: boolean;
  }> => {
    const stepRequestedAt = Date.now();
    const toolSchemas = params.tools.map(toToolSchema);

    const MAX_FORCE_TOOL_RETRIES = 3;

    let result!: Awaited<ReturnType<typeof callLlm>>;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: -1, cacheReadTokens: -1 };

    for (let attempt = 0; attempt < (config.forceToolCall ? MAX_FORCE_TOOL_RETRIES + 1 : 1); attempt++) {
      result = await callLlm({ ...config, signal: params.signal }, workingEntries, params.system, toolSchemas, {
        log: params.log,
        label: `step:${step}`,
        dumpId: params.chatId,
        maxImagesAllowed: params.maxImagesAllowed,
      });

      const add = (a: number, b: number) => (a === -1 || b === -1) ? -1 : a + b;
      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
        cacheCreationTokens: add(usage.cacheCreationTokens, result.usage.cacheCreationTokens),
        cacheReadTokens: add(usage.cacheReadTokens, result.usage.cacheReadTokens),
      };

      if (!config.forceToolCall) break;

      const hasTools = result.entries.length > 0 && extractToolCalls(result.entries).length > 0;
      if (hasTools) break;

      if (attempt < MAX_FORCE_TOOL_RETRIES) {
        params.log.withFields({
          chatId: params.chatId, step, attempt: attempt + 1, maxRetries: MAX_FORCE_TOOL_RETRIES,
        }).log('forceToolCall: model returned no tool calls, retrying');
      }
    }

    if (result!.entries.length === 0)
      return { stepEntries: [], usage, requestedAtMs: stepRequestedAt, hasToolCalls: false };

    const toolCalls = extractToolCalls(result!.entries);
    const toolResults: ToolResult[] = [];
    for (const tc of toolCalls)
      toolResults.push(await executeToolCall(tc.callId, tc.name, tc.args, params.tools, params.log));

    return {
      stepEntries: [...result.entries, ...toolResults],
      usage,
      requestedAtMs: stepRequestedAt,
      hasToolCalls: toolCalls.length > 0,
    };
  };

  const runStepLoop = async (params: StepLoopParams): Promise<void> => {
    let working: ConversationEntry[] = [...params.entries];
    let pendingPrune = false;

    for (let step = 1; step <= params.maxSteps; step++) {
      if (step > 0 && params.pullExternalEntries) {
        const externalEntries = await params.pullExternalEntries();
        if (externalEntries.length > 0)
          working = [...working, ...externalEntries];
      }
      if (params.shouldStop?.()) break;

      const { stepEntries, usage, requestedAtMs, hasToolCalls } =
        await runOneStep(working, params, step);

      if (stepEntries.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent');
        await params.onStepComplete([], usage, requestedAtMs);
        break;
      }

      const toolResults = stepEntries.filter((e): e is ToolResult => e.kind === 'toolResult');
      const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp);

      params.log.withFields({
        chatId: params.chatId, step,
        hasToolCalls, newEntries: stepEntries.length, usage,
      }).log('Step completed');

      const { pruned, pendingPrune: nextPrune } = pruneLengthLimitFailures(stepEntries, pendingPrune);
      pendingPrune = nextPrune;
      await params.onStepComplete(pruned, usage, requestedAtMs);

      if (!hasToolCalls || !anyRequiresFollowUp) {
        if (hasToolCalls && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      working = [...working, ...stepEntries];
    }
  };

  return { runStepLoop };
};
