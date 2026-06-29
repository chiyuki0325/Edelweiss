import type { Logger } from '@guiiai/logg';

import type { createRunner } from './runner';
import type { DriverFeature } from './turn-features';
import { runPrepareTurnFeatures, TurnPreparationSkipped } from './turn-features';
import { runTurnStepLoop } from './turn-loop';
import type { TurnState } from './turn-state';

export interface TurnPhases {
  prepareTurn(turn: TurnState, signal: AbortSignal): Promise<void>;
  runSteps(turn: TurnState): Promise<void>;
  finishTurn(turn: TurnState): Promise<void>;
  failTurn(turn: TurnState, error: unknown): Promise<void>;
  cleanupTurn(turn: TurnState): Promise<void>;
}

export interface TurnPhasesParams {
  runner: Pick<ReturnType<typeof createRunner>, 'callModelStep' | 'executeToolStep'>;
  executorChatId: string;
  log: Logger;
  maxImagesAllowed?: number;
  features: DriverFeature[];
}

export const createTurnPhases = (params: TurnPhasesParams): TurnPhases => {
  const runFeatureHook = async (
    turn: TurnState,
    hook: 'finishTurn' | 'cleanupTurn',
  ): Promise<void> => {
    for (const feature of params.features)
      await feature[hook]?.(turn);
  };

  return {
    prepareTurn: async (turn, signal) => {
      await runPrepareTurnFeatures(turn, params.features, signal);
    },
    runSteps: async turn => {
      await runTurnStepLoop(turn, {
        runner: params.runner,
        executorChatId: params.executorChatId,
        log: params.log,
        maxImagesAllowed: params.maxImagesAllowed,
        features: params.features,
      });
    },
    finishTurn: async turn => {
      await runFeatureHook(turn, 'finishTurn');
    },
    failTurn: async (turn, error) => {
      for (const feature of params.features)
        await feature.failTurn?.(turn, error);
    },
    cleanupTurn: async turn => {
      await runFeatureHook(turn, 'cleanupTurn');
    },
  };
};

export const runTurn = async (
  turn: TurnState,
  phases: TurnPhases,
): Promise<void> => {
  const signal = turn.abortController.signal;

  try {
    await phases.prepareTurn(turn, signal);
    signal.throwIfAborted();

    await phases.runSteps(turn);
    signal.throwIfAborted();

    await phases.finishTurn(turn);
  } catch (err) {
    if (signal.aborted) {
      turn.flags.interruptedByInput = true;
      return;
    }
    if (err instanceof TurnPreparationSkipped)
      return;

    await phases.failTurn(turn, err);
    throw err;
  } finally {
    await phases.cleanupTurn(turn);
  }
};
