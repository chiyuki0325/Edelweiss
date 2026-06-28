import type { Logger } from '@guiiai/logg';

import type { createRunner } from './runner';
import type { CompletedStep, TurnState } from './turn-state';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

type Awaitable<T> = T | Promise<T>;

export interface TurnStepLoopParams {
  runner: Pick<ReturnType<typeof createRunner>, 'runOneStep'>;
  executorChatId: string;
  log: Logger;
  maxImagesAllowed?: number;
  pullExternalEntries?: (turn: TurnState) => Awaitable<ConversationEntry[]>;
  shouldStop?: (turn: TurnState) => boolean;
  transformStepEntries?: (
    turn: TurnState,
    entries: ConversationEntry[],
  ) => Awaitable<ConversationEntry[]>;
  persistStep: (turn: TurnState, step: CompletedStep) => Awaitable<void>;
  shouldContinue?: (turn: TurnState, step: CompletedStep) => Awaitable<boolean | undefined>;
}

export const runTurnStepLoop = async (
  turn: TurnState,
  params: TurnStepLoopParams,
): Promise<void> => {
  let working = [...turn.entries];

  for (; turn.step <= turn.maxSteps;) {
    const stepNumber = turn.step;
    const externalEntries = await params.pullExternalEntries?.(turn) ?? [];
    if (externalEntries.length > 0)
      working = [...working, ...externalEntries];

    if (params.shouldStop?.(turn)) break;

    const { stepEntries, usage, requestedAtMs, hasToolCalls } = await params.runner.runOneStep(working, {
      signal: turn.abortController.signal,
      chatId: params.executorChatId,
      system: turn.system,
      tools: turn.tools,
      maxImagesAllowed: params.maxImagesAllowed,
      log: params.log,
    }, stepNumber);

    if (stepEntries.length === 0) {
      turn.flags.modelStayedSilent = true;
      params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('Model chose to stay silent');
      await params.persistStep(turn, {
        rawEntries: [],
        persistedEntries: [],
        usage,
        requestedAtMs,
        hasToolCalls: false,
        anyRequiresFollowUp: false,
      });
      break;
    }

    const toolResults = stepEntries.filter((e): e is ToolResult => e.kind === 'toolResult');
    const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp);

    params.log.withFields({
      chatId: params.executorChatId,
      step: stepNumber,
      hasToolCalls,
      newEntries: stepEntries.length,
      usage,
    }).log('Step completed');

    const persistedEntries = await params.transformStepEntries?.(turn, stepEntries) ?? stepEntries;
    const completedStep: CompletedStep = {
      rawEntries: stepEntries,
      persistedEntries,
      usage,
      requestedAtMs,
      hasToolCalls,
      anyRequiresFollowUp,
    };
    await params.persistStep(turn, completedStep);

    if (!hasToolCalls || !anyRequiresFollowUp) {
      if (hasToolCalls && !anyRequiresFollowUp)
        params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('All tool calls completed without follow-up');
      break;
    }

    if (await params.shouldContinue?.(turn, completedStep) === false)
      break;

    working = [...working, ...completedStep.rawEntries];
    turn.entries = working;
    turn.step++;
  }
};
