import type { Logger } from '@guiiai/logg';

import type { createRunner } from './runner';
import type { DriverFeature } from './turn-features';
import type { CompletedStep, TurnState } from './turn-state';
import type { ConversationEntry } from '../unified-api/types';

type Awaitable<T> = T | Promise<T>;

export interface TurnStepLoopParams {
  runner: Pick<ReturnType<typeof createRunner>, 'callModelStep' | 'executeToolStep'>;
  executorChatId: string;
  log: Logger;
  maxImagesAllowed?: number;
  features?: DriverFeature[];
  pullExternalEntries?: (turn: TurnState) => Awaitable<ConversationEntry[]>;
  shouldStop?: (turn: TurnState) => boolean;
  transformStepEntries?: (
    turn: TurnState,
    entries: ConversationEntry[],
  ) => Awaitable<ConversationEntry[]>;
  persistStep?: (turn: TurnState, step: CompletedStep) => Awaitable<void>;
  shouldContinue?: (turn: TurnState, step: CompletedStep) => Awaitable<boolean | undefined>;
}

export const runTurnStepLoop = async (
  turn: TurnState,
  params: TurnStepLoopParams,
): Promise<void> => {
  let working = [...turn.entries];
  const features = params.features ?? [];
  const persistCompletedStep = async (step: CompletedStep): Promise<void> => {
    await params.persistStep?.(turn, step);
    for (const feature of features)
      await feature.persistStep?.(turn, step);
  };

  for (; turn.step <= turn.maxSteps;) {
    turn.abortController.signal.throwIfAborted();
    const stepNumber = turn.step;
    for (const feature of features)
      await feature.beforeStep?.(turn);
    turn.abortController.signal.throwIfAborted();
    working = [...turn.entries];

    const externalEntries = await params.pullExternalEntries?.(turn) ?? [];
    turn.abortController.signal.throwIfAborted();
    if (externalEntries.length > 0)
      working = [...working, ...externalEntries];

    if (params.shouldStop?.(turn)) break;

    for (const feature of features)
      await feature.beforeModelCall?.(turn);
    turn.abortController.signal.throwIfAborted();

    const stepParams = {
      signal: turn.abortController.signal,
      chatId: params.executorChatId,
      system: turn.system,
      tools: turn.tools,
      maxImagesAllowed: params.maxImagesAllowed,
      log: params.log,
    };
    const modelOutput = await params.runner.callModelStep(working, stepParams, stepNumber);
    turn.abortController.signal.throwIfAborted();
    for (const feature of features)
      await feature.afterModelCall?.(turn, modelOutput);
    turn.abortController.signal.throwIfAborted();

    const toolResults = await params.runner.executeToolStep(modelOutput.toolCalls, stepParams);
    turn.abortController.signal.throwIfAborted();
    const stepEntries = [...modelOutput.entries, ...toolResults];
    const usage = modelOutput.usage;
    const requestedAtMs = modelOutput.requestedAtMs;
    const hasToolCalls = modelOutput.toolCalls.length > 0;

    if (stepEntries.length === 0) {
      turn.flags.modelStayedSilent = true;
      params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('Model chose to stay silent');
      await persistCompletedStep({
        rawEntries: [],
        persistedEntries: [],
        usage,
        requestedAtMs,
        hasToolCalls: false,
        anyRequiresFollowUp: false,
      });
      break;
    }

    const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp);
    for (const feature of features)
      await feature.afterToolResults?.(turn, { entries: stepEntries });

    params.log.withFields({
      chatId: params.executorChatId,
      step: stepNumber,
      hasToolCalls,
      newEntries: stepEntries.length,
      usage,
    }).log('Step completed');

    let persistedEntries = await params.transformStepEntries?.(turn, stepEntries) ?? stepEntries;
    for (const feature of features)
      persistedEntries = await feature.transformStepEntries?.(turn, persistedEntries) ?? persistedEntries;
    const completedStep: CompletedStep = {
      rawEntries: stepEntries,
      persistedEntries,
      usage,
      requestedAtMs,
      hasToolCalls,
      anyRequiresFollowUp,
    };
    await persistCompletedStep(completedStep);

    if (!hasToolCalls || !anyRequiresFollowUp) {
      if (hasToolCalls && !anyRequiresFollowUp)
        params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('All tool calls completed without follow-up');
      break;
    }

    let shouldContinue = await params.shouldContinue?.(turn, completedStep);
    for (const feature of features) {
      const opinion = await feature.shouldContinue?.(turn, completedStep);
      if (opinion !== undefined)
        shouldContinue = opinion;
    }
    if (shouldContinue === false)
      break;

    working = [...working, ...completedStep.rawEntries];
    turn.entries = working;
    turn.step++;
  }
};
