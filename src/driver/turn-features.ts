import type { ModelStepOutput } from './runner';
import type { CompletedStep, TurnState } from './turn-state';
import type { ConversationEntry } from '../unified-api/types';

export type Awaitable<T> = T | Promise<T>;

export interface StepOutput {
  entries: ConversationEntry[];
}

export interface DriverFeature {
  name: string;

  prepareTurn?(turn: TurnState, signal: AbortSignal): Awaitable<void>;
  prepareContext?(turn: TurnState, signal: AbortSignal): Awaitable<void>;
  preparePrompt?(turn: TurnState, signal: AbortSignal): Awaitable<void>;
  prepareCapabilities?(turn: TurnState, signal: AbortSignal): Awaitable<void>;
  prepareTools?(turn: TurnState, signal: AbortSignal): Awaitable<void>;

  beforeStep?(turn: TurnState): Awaitable<void>;
  beforeModelCall?(turn: TurnState): Awaitable<void>;
  afterModelCall?(turn: TurnState, output: ModelStepOutput): Awaitable<void>;
  afterToolResults?(turn: TurnState, output: StepOutput): Awaitable<void>;
  transformStepEntries?(
    turn: TurnState,
    entries: ConversationEntry[],
  ): Awaitable<ConversationEntry[]>;
  persistStep?(turn: TurnState, step: CompletedStep): Awaitable<void>;
  shouldContinue?(turn: TurnState, step: CompletedStep): Awaitable<boolean | undefined>;

  finishTurn?(turn: TurnState): Awaitable<void>;
  failTurn?(turn: TurnState, error: unknown): Awaitable<void>;
  cleanupTurn?(turn: TurnState): Awaitable<void>;
}

export class TurnPreparationSkipped extends Error {
  constructor(message = 'Turn preparation skipped') {
    super(message);
    this.name = 'TurnPreparationSkipped';
  }
}

export const runPrepareTurnFeatures = async (
  turn: TurnState,
  features: DriverFeature[],
  signal: AbortSignal,
): Promise<void> => {
  const runHook = async (hook: keyof Pick<DriverFeature, 'prepareTurn' | 'prepareContext' | 'prepareCapabilities' | 'prepareTools' | 'preparePrompt'>): Promise<void> => {
    for (const feature of features) {
      signal.throwIfAborted();
      await feature[hook]?.(turn, signal);
      signal.throwIfAborted();
    }
  };

  await runHook('prepareTurn');
  await runHook('prepareContext');
  await runHook('prepareCapabilities');
  await runHook('prepareTools');
  await runHook('preparePrompt');
};
