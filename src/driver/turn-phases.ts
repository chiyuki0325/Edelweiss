import type { Logger } from '@guiiai/logg';

import type { createRunner } from './runner';
import type { DriverFeature, TurnContext } from './turn-features';
import { createTurnContext, runFeatureEffects, runPrepareTurnFeatures, TurnPreparationSkipped } from './turn-features';
import { runTurnStepLoop } from './turn-loop';
import type { TurnState } from './turn-state';

export interface TurnPhases {
  prepareTurn(ctx: TurnContext): Promise<void>;
  runSteps(ctx: TurnContext): Promise<void>;
  finishTurn(ctx: TurnContext): Promise<void>;
  failTurn(ctx: TurnContext, error: unknown): Promise<void>;
  cleanupTurn(ctx: TurnContext): Promise<void>;
}

export interface TurnPhasesParams {
  runner: Pick<ReturnType<typeof createRunner>, 'callModelStep' | 'executeToolStep'>;
  executorChatId: string;
  log: Logger;
  maxImagesAllowed?: number;
  features: DriverFeature[];
}

export const createTurnPhases = (params: TurnPhasesParams): TurnPhases => {
  return {
    prepareTurn: async ctx => {
      await runPrepareTurnFeatures(ctx, params.features);
    },
    runSteps: async ctx => {
      await runTurnStepLoop(ctx, {
        runner: params.runner,
        executorChatId: params.executorChatId,
        log: params.log,
        maxImagesAllowed: params.maxImagesAllowed,
        features: params.features,
      });
    },
    finishTurn: async ctx => {
      await runFeatureEffects(ctx, params.features, 'finishTurn');
    },
    failTurn: async (ctx, error) => {
      for (const feature of params.features)
        await feature.failTurn?.(ctx, error);
    },
    cleanupTurn: async ctx => {
      await runFeatureEffects(ctx, params.features, 'cleanupTurn');
    },
  };
};

export const runTurn = async (
  turn: TurnState,
  phases: TurnPhases,
): Promise<void> => {
  const ctx = createTurnContext(turn);
  const signal = ctx.signal;

  try {
    await phases.prepareTurn(ctx);
    signal.throwIfAborted();

    await phases.runSteps(ctx);
    signal.throwIfAborted();

    await phases.finishTurn(ctx);
  } catch (err) {
    if (signal.aborted) {
      turn.flags.interruptedByInput = true;
      return;
    }
    if (err instanceof TurnPreparationSkipped)
      return;

    await phases.failTurn(ctx, err);
    throw err;
  } finally {
    await phases.cleanupTurn(ctx);
  }
};
