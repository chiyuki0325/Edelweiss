import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from '../driver/tools';
import type { TurnResponseV2 } from '../driver/types';
import type { LlmEndpoint, Usage } from '../llm/types';
import type { IntermediateContext } from '../projection/types';
import type { RenderParams } from '../rendering/types';
import type { ConversationEntry, ToolCallPart } from '../unified-api/types';

export type EvalToolName = 'send_message' | 'stay_silent' | 'load_skill';

export type EvalIcSource =
  | string
  | IntermediateContext
  | EvalFixture;

export interface EvalFixture {
  name?: string;
  ic: IntermediateContext;
  turnResponses?: TurnResponseV2[];
  compactSummary?: string;
}

export type EvalSystemFileSource =
  | string
  | {
    filename: string;
    content: string;
  };

export interface EvalPromptVariant {
  name: string;
  template: string;
  params?: Record<string, unknown>;
  systemFiles?: EvalSystemFileSource[];
}

export interface EvalLateBindingParams {
  timeNow?: string;
  isMentioned?: boolean;
  isReplied?: boolean;
  recentSendMessageHumanLikenessXml?: string;
  activeBackgroundTasks?: {
    id: number;
    typeName: string;
    intention?: string;
    liveSummary: string;
    startedMs: number;
    timeoutMs: number;
  }[];
  isInterrupted?: boolean;
}

export interface EvalScenario {
  name: string;
  ic: EvalIcSource | EvalIcSource[];
  prompts: EvalPromptVariant[];
  evaluator: string | EvalEvaluator;
  repeats?: number;
  model?: string | LlmEndpoint;
  maxSteps?: number;
  maxContextEstTokens?: number;
  renderParams?: RenderParams;
  lateBinding?: false | EvalLateBindingParams;
  skillsFolder?: string;
  enabledTools?: EvalToolName[];
  extraTools?: (context: EvalToolFactoryContext) => CahciuaTool[] | Promise<CahciuaTool[]>;
}

export interface EvalSuite {
  name: string;
  scenarios: EvalScenario[];
  repeats?: number;
  model: string | LlmEndpoint;
  maxSteps?: number;
  maxContextEstTokens?: number;
  outputDir?: string;
}

export interface EvalToolFactoryContext {
  suite: EvalSuite;
  scenario: EvalScenario;
  prompt: EvalPromptVariant;
  icName: string;
  repeatIndex: number;
  log: Logger;
}

export interface EvalCapturedMessage {
  messageId: string;
  text: string;
  replyTo?: string;
  attachments?: {
    type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
    path: string;
    file_name?: string;
  }[];
}

export interface EvalToolTrace {
  loadedSkills: string[];
  sentMessages: EvalCapturedMessage[];
}

export interface EvalEvaluation {
  passed: boolean;
  score?: number;
  labels?: Record<string, boolean | number | string>;
  notes?: string;
}

export interface EvalRun {
  suiteName: string;
  scenarioName: string;
  icName: string;
  promptName: string;
  repeatIndex: number;
  modelName: string;
  system: string;
  entries: ConversationEntry[];
  stepEntries: ConversationEntry[];
  toolCalls: ToolCallPart[];
  toolTrace: EvalToolTrace;
  usage: Usage;
  requestedAtMs: number;
  completedAtMs: number;
  error?: string;
}

export interface EvalRunResult extends EvalRun {
  evaluation: EvalEvaluation;
}

export type EvalEvaluator = (run: EvalRun) => EvalEvaluation | Promise<EvalEvaluation>;

export interface EvalConditionSummary {
  suiteName: string;
  scenarioName: string;
  icName: string;
  promptName: string;
  repeats: number;
  failures: number;
  passRate: number;
  passWilsonLow: number;
  passWilsonHigh: number;
  averageScore: number | null;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageLatencyMs: number;
  labelRates: Record<string, number>;
}

export interface EvalSuiteSummary {
  suiteName: string;
  generatedAt: string;
  runs: number;
  conditions: EvalConditionSummary[];
}
