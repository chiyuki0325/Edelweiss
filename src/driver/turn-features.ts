import type { ModelStepOutput } from './runner';
import type { CompletedStep, TurnState } from './turn-state';
import type { ConversationEntry } from '../unified-api/types';

export type Awaitable<T> = T | Promise<T>;

export interface TurnScratch {
  contextEstimatedTokens: number;
  recentSendMessageHumanLikenessXml: string;
}

export interface TurnContext {
  turn: TurnState;
  scratch: TurnScratch;
  signal: AbortSignal;
}

export const createTurnScratch = (): TurnScratch => ({
  contextEstimatedTokens: 0,
  recentSendMessageHumanLikenessXml: '',
});

export const createTurnContext = (turn: TurnState): TurnContext => ({
  turn,
  scratch: createTurnScratch(),
  signal: turn.abortController.signal,
});

export interface StepOutput {
  entries: ConversationEntry[];
}

export interface DriverFeature {
  name: string;

  prepareTurn?(ctx: TurnContext): Awaitable<void>;
  prepareContext?(ctx: TurnContext): Awaitable<void>;
  preparePrompt?(ctx: TurnContext): Awaitable<void>;
  prepareCapabilities?(ctx: TurnContext): Awaitable<void>;
  prepareTools?(ctx: TurnContext): Awaitable<void>;

  beforeStep?(ctx: TurnContext): Awaitable<void>;
  beforeModelCall?(ctx: TurnContext): Awaitable<void>;
  afterModelCall?(ctx: TurnContext, output: ModelStepOutput): Awaitable<void>;
  afterToolResults?(ctx: TurnContext, output: StepOutput): Awaitable<void>;
  transformStepEntries?(
    ctx: TurnContext,
    entries: ConversationEntry[],
  ): Awaitable<ConversationEntry[]>;
  persistStep?(ctx: TurnContext, step: CompletedStep): Awaitable<void>;
  shouldContinue?(ctx: TurnContext, step: CompletedStep): Awaitable<boolean | undefined>;

  finishTurn?(ctx: TurnContext): Awaitable<void>;
  failTurn?(ctx: TurnContext, error: unknown): Awaitable<void>;
  cleanupTurn?(ctx: TurnContext): Awaitable<void>;
}

export class TurnPreparationSkipped extends Error {
  constructor(message = 'Turn preparation skipped') {
    super(message);
    this.name = 'TurnPreparationSkipped';
  }
}

type EffectHook = keyof Pick<
  DriverFeature,
  | 'beforeModelCall'
  | 'beforeStep'
  | 'cleanupTurn'
  | 'finishTurn'
  | 'prepareCapabilities'
  | 'prepareContext'
  | 'preparePrompt'
  | 'prepareTools'
  | 'prepareTurn'
>;

export const runFeatureEffects = async (
  ctx: TurnContext,
  features: DriverFeature[],
  hook: EffectHook,
  options: { checkAbort?: boolean } = {},
): Promise<void> => {
  for (const feature of features) {
    if (options.checkAbort) ctx.signal.throwIfAborted();
    await feature[hook]?.(ctx);
    if (options.checkAbort) ctx.signal.throwIfAborted();
  }
};

export const runFeatureTransform = async (
  ctx: TurnContext,
  features: DriverFeature[],
  hook: 'transformStepEntries',
  value: ConversationEntry[],
): Promise<ConversationEntry[]> => {
  let next = value;
  for (const feature of features)
    next = await feature[hook]?.(ctx, next) ?? next;
  return next;
};

export const runFeatureDecision = async (
  ctx: TurnContext,
  features: DriverFeature[],
  hook: 'shouldContinue',
  value: CompletedStep,
  initial: boolean | undefined,
): Promise<boolean | undefined> => {
  let decision = initial;
  for (const feature of features) {
    const opinion = await feature[hook]?.(ctx, value);
    if (opinion !== undefined)
      decision = opinion;
  }
  return decision;
};

export const runPrepareTurnFeatures = async (
  ctx: TurnContext,
  features: DriverFeature[],
): Promise<void> => {
  await runFeatureEffects(ctx, features, 'prepareTurn', { checkAbort: true });
  await runFeatureEffects(ctx, features, 'prepareContext', { checkAbort: true });
  await runFeatureEffects(ctx, features, 'prepareCapabilities', { checkAbort: true });
  await runFeatureEffects(ctx, features, 'prepareTools', { checkAbort: true });
  await runFeatureEffects(ctx, features, 'preparePrompt', { checkAbort: true });
};
