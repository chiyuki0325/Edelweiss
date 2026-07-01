import type { Logger } from '@guiiai/logg';

import type { createRunner } from './runner';
import type { DriverFeature, TurnContext } from './turn-features';
import { runFeatureDecision, runFeatureEffects, runFeatureTransform } from './turn-features';
import type { CompletedStep } from './turn-state';
import type { ConversationEntry } from '../unified-api/types';

type Awaitable<T> = T | Promise<T>;

export interface TurnStepLoopParams {
  runner: Pick<ReturnType<typeof createRunner>, 'callModelStep' | 'executeToolStep'>;
  executorChatId: string;
  log: Logger;
  maxImagesAllowed?: number;
  features?: DriverFeature[];
  pullExternalEntries?: (ctx: TurnContext) => Awaitable<ConversationEntry[]>;
  shouldStop?: (ctx: TurnContext) => boolean;
  transformStepEntries?: (
    ctx: TurnContext,
    entries: ConversationEntry[],
  ) => Awaitable<ConversationEntry[]>;
  persistStep?: (ctx: TurnContext, step: CompletedStep) => Awaitable<void>;
  shouldContinue?: (ctx: TurnContext, step: CompletedStep) => Awaitable<boolean | undefined>;
}

export const runTurnStepLoop = async (
  ctx: TurnContext,
  params: TurnStepLoopParams,
): Promise<void> => {
  const { turn } = ctx;
  let working = [...turn.entries];
  const features = params.features ?? [];
  const persistCompletedStep = async (step: CompletedStep): Promise<void> => {
    await params.persistStep?.(ctx, step);
    for (const feature of features)
      await feature.persistStep?.(ctx, step);
  };

  for (; turn.step <= turn.maxSteps;) {
    turn.abortController.signal.throwIfAborted();
    const stepNumber = turn.step;
    await runFeatureEffects(ctx, features, 'beforeStep');
    turn.abortController.signal.throwIfAborted();
    working = [...turn.entries];

    const externalEntries = await params.pullExternalEntries?.(ctx) ?? [];
    turn.abortController.signal.throwIfAborted();
    if (externalEntries.length > 0)
      working = [...working, ...externalEntries];

    if (params.shouldStop?.(ctx)) break;

    await runFeatureEffects(ctx, features, 'beforeModelCall');
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
      await feature.afterModelCall?.(ctx, modelOutput);
    turn.abortController.signal.throwIfAborted();

    const hasProtectedTool = modelOutput.toolCalls.some(tc => tc.name === 'send_message');
    if (hasProtectedTool) turn.scope.scheduler.abortLocked = true;

    const toolResults = await params.runner.executeToolStep(modelOutput.toolCalls, stepParams);
    turn.abortController.signal.throwIfAborted();
    const stepEntries = [...modelOutput.entries, ...toolResults];
    const usage = modelOutput.usage;
    const requestedAtMs = modelOutput.requestedAtMs;
    const hasToolCalls = modelOutput.toolCalls.length > 0;

    if (stepEntries.length === 0) {
      turn.flags.modelStayedSilent = true;
      params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('Model chose to stay silent');
      if (hasProtectedTool) {
        turn.scope.scheduler.abortLocked = false;
        if (turn.scope.scheduler.pendingAbort) {
          turn.scope.scheduler.pendingAbort = false;
          turn.abortController.abort(new Error('Deferred: new messages arrived during protected step'));
        }
      }
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
      await feature.afterToolResults?.(ctx, { entries: stepEntries });

    params.log.withFields({
      chatId: params.executorChatId,
      step: stepNumber,
      hasToolCalls,
      newEntries: stepEntries.length,
      usage,
    }).log('Step completed');

    let persistedEntries = await params.transformStepEntries?.(ctx, stepEntries) ?? stepEntries;
    persistedEntries = await runFeatureTransform(ctx, features, 'transformStepEntries', persistedEntries);
    const completedStep: CompletedStep = {
      rawEntries: stepEntries,
      persistedEntries,
      usage,
      requestedAtMs,
      hasToolCalls,
      anyRequiresFollowUp,
    };
    await persistCompletedStep(completedStep);

    if (hasProtectedTool) {
      turn.scope.scheduler.abortLocked = false;
      if (turn.scope.scheduler.pendingAbort) {
        turn.scope.scheduler.pendingAbort = false;
        turn.abortController.abort(new Error('Deferred: new messages arrived during protected step'));
      }
    }
    turn.abortController.signal.throwIfAborted();

    if (!hasToolCalls || !anyRequiresFollowUp) {
      if (hasToolCalls && !anyRequiresFollowUp)
        params.log.withFields({ chatId: params.executorChatId, step: stepNumber }).log('All tool calls completed without follow-up');
      break;
    }

    let shouldContinue = await params.shouldContinue?.(ctx, completedStep);
    shouldContinue = await runFeatureDecision(ctx, features, 'shouldContinue', completedStep, shouldContinue);
    if (shouldContinue === false)
      break;

    working = [...working, ...completedStep.rawEntries];
    turn.entries = working;
    turn.step++;
  }
};
