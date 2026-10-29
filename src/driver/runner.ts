import type { Logger } from '@guiiai/logg';
import type { ToolMessage } from '@langchain/core/messages';
import { AIMessage, isAIMessage, isToolMessage } from '@langchain/core/messages';

import { callLlm, type LlmCallConfig, type ToolSchema } from './call-llm';
import { ensureDumpDir } from './constants';
import {
  cloneMessage,
  messageText,
  toolCalls,
  type DriverMessage,
  type DriverToolCall,
  type DriverToolMessage,
} from './messages';
import { executePreparedToolCall, prepareToolCall, type CahciuaTool, type PreparedToolCall } from './tools';
import type { Usage } from '../llm/types';

ensureDumpDir();

const isRecoverableSendMessageFailure = (tr: ToolMessage): boolean => {
  if (typeof tr.content !== 'string') return false;
  try {
    const parsed = JSON.parse(tr.content);
    return parsed.ok === false
      && (parsed.code === 'agreement_review_required'
        || parsed.code === 'contrast_review_required'
        || (typeof parsed.error === 'string' && parsed.error.includes('too long')));
  } catch {
    return false;
  }
};

/**
 * Prune recoverable send_message failures (length limit or draft review),
 * plus the thinking content between the failure and the next visible resolution.
 *
 * This is a few-shot cleanup: the pruned entries are what gets persisted (future context
 * won't see the "try long → fail → split" pattern). The live working context within the
 * current turn is NOT pruned — the model needs to see its error to correct.
 */
export const pruneLengthLimitFailures = (
  entries: DriverMessage[],
  pendingPrune: boolean,
): { pruned: DriverMessage[]; pendingPrune: boolean } => {
  const result = entries.map(entry => cloneMessage(entry));

  let nextPendingPrune = pendingPrune;

  // Step 1: If a previous step had a recoverable failure, remove all thinking
  // (TextPart / ReasoningPart) before the first visible resolution in this step.
  if (nextPendingPrune) {
    for (const entry of result) {
      if (!isAIMessage(entry)) continue;
      const firstResolutionIdx = (entry.tool_calls ?? []).findIndex(call =>
        call.name === 'send_message' || call.name === 'react_message' || call.name === 'stay_silent');
      if (firstResolutionIdx >= 0) {
        const index = result.indexOf(entry);
        result[index] = new AIMessage({
          ...entry,
          content: [],
          tool_calls: entry.tool_calls,
        });
        nextPendingPrune = false;
        break;
      }
    }
  }

  // Step 2: Find and remove recoverable send_message failures.
  // Iterate in reverse so splice indices stay valid during removal.
  for (let i = result.length - 1; i >= 0; i--) {
    const entry = result[i]!;
    if (!isToolMessage(entry)) continue;
    if (!isRecoverableSendMessageFailure(entry)) continue;

    // Find the matching ToolCallPart in a preceding OutputMessage
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const e = result[j]!;
      if (!isAIMessage(e)) continue;
      const tcIdx = (e.tool_calls ?? []).findIndex(
        call => call.id === entry.tool_call_id && call.name === 'send_message',
      );
      if (tcIdx === -1) continue;

      const calls = [...(e.tool_calls ?? [])];
      calls.splice(tcIdx, 1);
      result[j] = new AIMessage({ ...e, content: [], tool_calls: calls });
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
    if (isAIMessage(entry))
      for (const call of entry.tool_calls ?? [])
        if (call.id) remainingCallIds.add(call.id);
  }

  const cleaned = result.filter(entry => {
    if (isAIMessage(entry) && !messageText(entry) && !(entry.tool_calls?.length))
      return false;
    if (isToolMessage(entry) && !remainingCallIds.has(entry.tool_call_id))
      return false;
    return true;
  });

  return { pruned: cleaned, pendingPrune: nextPendingPrune };
};

export interface RunnerConfig extends LlmCallConfig {}

export interface StepExecutorParams {
  chatId: string;
  system: string;
  tools: CahciuaTool[];
  maxImagesAllowed?: number;
  signal?: AbortSignal;
  log: Logger;
}

export interface ExecutedStep {
  stepEntries: DriverMessage[];
  usage: Usage;
  requestedAtMs: number;
  hasToolCalls: boolean;
}

export interface ModelStepOutput {
  entries: DriverMessage[];
  toolCalls: DriverToolCall[];
  usage: Usage;
  requestedAtMs: number;
}

export const toToolSchema = (t: CahciuaTool): ToolSchema => ({
  name: t.function.name,
  parameters: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

export const createRunner = (config: RunnerConfig) => {
  const callModelStep = async (
    workingEntries: DriverMessage[],
    params: StepExecutorParams,
    step: number,
  ): Promise<ModelStepOutput> => {
    const stepRequestedAt = Date.now();
    const toolSchemas = params.tools.map(toToolSchema);

    const result = await callLlm({ ...config, signal: params.signal }, workingEntries, params.system, toolSchemas, {
      log: params.log,
      label: `step:${step}`,
      dumpId: params.chatId,
      maxImagesAllowed: params.maxImagesAllowed,
    });

    return {
      entries: result!.entries,
      toolCalls: toolCalls(result!.entries),
      usage: result.usage,
      requestedAtMs: stepRequestedAt,
    };
  };

  const executeToolStep = async (
    toolCalls: DriverToolCall[],
    params: StepExecutorParams,
  ): Promise<DriverToolMessage[]> => {
    const toolResults = new Array<DriverToolMessage>(toolCalls.length);
    const lanes: Record<'prelude' | 'readonly' | 'writer' | 'message' | 'serial', Array<{ index: number; call: PreparedToolCall }>> = {
      prelude: [],
      readonly: [],
      writer: [],
      message: [],
      serial: [],
    };

    for (const [index, tc] of toolCalls.entries()) {
      const prepared = prepareToolCall(tc.id, tc.name, JSON.stringify(tc.args), params.tools, params.log);
      if (!prepared.ok) {
        toolResults[index] = prepared.result;
        continue;
      }
      const lane = prepared.call.tool.execution?.lane ?? 'serial';
      lanes[lane].push({ index, call: prepared.call });
    }

    const execute = async ({ index, call }: { index: number; call: PreparedToolCall }): Promise<void> => {
      toolResults[index] = await executePreparedToolCall(call, params.log);
    };
    const runSerial = async (calls: Array<{ index: number; call: PreparedToolCall }>, before?: Promise<void>): Promise<void> => {
      for (const item of calls) {
        if (item.call.tool.execution?.waitForWriters?.(item.call.input)) await before;
        await execute(item);
      }
    };

    // Prelude calls (currently enter_focus) must settle before any other lane starts.
    await runSerial(lanes.prelude);

    // Writer failures are converted to ToolResults, so this barrier always releases.
    const writersDone = runSerial(lanes.writer);
    const readonlyDone = Promise.all(lanes.readonly.map(async item => {
      if (item.call.tool.execution?.waitForWriters?.(item.call.input)) await writersDone;
      await execute(item);
    })).then(() => undefined);
    const messagesDone = runSerial(lanes.message, writersDone);
    const serialDone = runSerial(lanes.serial);

    await Promise.all([writersDone, readonlyDone, messagesDone, serialDone]);
    return toolResults;
  };

  const runOneStep = async (
    workingEntries: DriverMessage[],
    params: StepExecutorParams,
    step: number,
  ): Promise<ExecutedStep> => {
    const modelOutput = await callModelStep(workingEntries, params, step);
    if (modelOutput.entries.length === 0) {
      return {
        stepEntries: [],
        usage: modelOutput.usage,
        requestedAtMs: modelOutput.requestedAtMs,
        hasToolCalls: false,
      };
    }

    const toolResults = await executeToolStep(modelOutput.toolCalls, params);

    return {
      stepEntries: [...modelOutput.entries, ...toolResults],
      usage: modelOutput.usage,
      requestedAtMs: modelOutput.requestedAtMs,
      hasToolCalls: modelOutput.toolCalls.length > 0,
    };
  };

  return { callModelStep, executeToolStep, runOneStep };
};
