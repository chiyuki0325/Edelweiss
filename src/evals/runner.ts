import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Logger } from '@guiiai/logg';

import { writeEvalReport } from './report';
import { createEvalTools } from './tools';
import type {
  EvalEvaluator,
  EvalFixture,
  EvalIcSource,
  EvalPromptVariant,
  EvalRun,
  EvalRunResult,
  EvalScenario,
  EvalSuite,
  EvalSystemFileSource,
} from './types';
import { composeContext, injectLateBindingPrompt } from '../driver/context';
import { renderLateBindingPrompt } from '../driver/prompt';
import { createRunner } from '../driver/runner';
import { loadSkillsFromFolder } from '../driver/skills';
import { extractToolCalls } from '../driver/tools';
import type { CahciuaTool } from '../driver/tools';
import type { TurnResponseV2 } from '../driver/types';
import type { LlmEndpoint, Usage } from '../llm/types';
import type { IntermediateContext } from '../projection/types';
import { renderPromptTemplate } from '../prompt-template';
import { render } from '../rendering';
import type { ConversationEntry } from '../unified-api/types';

const PACKAGE_BASE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const resolveFrom = (baseDir: string, filePath: string): string =>
  isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);

const loadDefaultExport = async <T>(filePath: string): Promise<T> => {
  const mod = await import(pathToFileURL(filePath).href) as {
    default?: T;
  } & Record<string, unknown>;
  if (mod.default != null) return mod.default;
  throw new Error(`Module ${filePath} must export default`);
};

const loadEvaluator = async (source: string | EvalEvaluator, baseDir: string): Promise<EvalEvaluator> =>
  typeof source === 'function'
    ? source
    : await loadDefaultExport<EvalEvaluator>(resolveFrom(baseDir, source));

interface LoadedEvalFixture {
  name: string;
  ic: IntermediateContext;
  turnResponses?: TurnResponseV2[];
  compactSummary?: string;
}

const isEvalFixture = (value: unknown): value is EvalFixture =>
  typeof value === 'object' && value !== null && 'ic' in value;

const toLoadedFixture = (
  value: IntermediateContext | EvalFixture,
  fallbackName: string,
): LoadedEvalFixture => {
  if (isEvalFixture(value)) {
    return {
      name: value.name ?? fallbackName,
      ic: value.ic,
      turnResponses: value.turnResponses,
      compactSummary: value.compactSummary,
    };
  }
  return { name: fallbackName, ic: value };
};

const loadIcModule = async (
  filePath: string,
): Promise<IntermediateContext | EvalFixture | (IntermediateContext | EvalFixture)[]> => {
  const mod = await import(pathToFileURL(filePath).href) as {
    default?: unknown;
    ic?: unknown;
    contexts?: unknown;
  };
  const value = mod.default ?? mod.ic ?? mod.contexts;
  if (!value) throw new Error(`IC fixture ${filePath} must export default, ic, or contexts`);
  return value as IntermediateContext | EvalFixture | (IntermediateContext | EvalFixture)[];
};

const loadIcSources = async (
  source: EvalIcSource | EvalIcSource[],
  baseDir: string,
): Promise<LoadedEvalFixture[]> => {
  const sources = Array.isArray(source) ? source : [source];
  const result: LoadedEvalFixture[] = [];

  for (const item of sources) {
    if (typeof item === 'string') {
      const filePath = resolveFrom(baseDir, item);
      const loaded = await loadIcModule(filePath);
      const fallbackName = basename(filePath).replace(/\.[^.]+$/, '');
      if (Array.isArray(loaded)) {
        for (const ctx of loaded)
          result.push(toLoadedFixture(ctx, isEvalFixture(ctx) ? (ctx.name ?? fallbackName) : ctx.sessionId));
      } else {
        result.push(toLoadedFixture(loaded, isEvalFixture(loaded) ? (loaded.name ?? fallbackName) : fallbackName));
      }
    } else {
      if (isEvalFixture(item))
        result.push(toLoadedFixture(item, item.name ?? item.ic.sessionId));
      else
        result.push(toLoadedFixture(item, item.sessionId));
    }
  }

  return result;
};

const loadSystemFiles = (sources: EvalSystemFileSource[] | undefined, baseDir: string): { filename: string; content: string }[] =>
  (sources ?? []).map(source => {
    if (typeof source !== 'string') return source;
    const filePath = resolveFrom(baseDir, source);
    return {
      filename: basename(filePath),
      content: readFileSync(filePath, 'utf-8').trim(),
    };
  });

const loadPrompt = async (
  prompt: EvalPromptVariant,
  endpoint: LlmEndpoint,
  scenario: EvalScenario,
  baseDir: string,
): Promise<string> => {
  const templatePath = resolveFrom(baseDir, prompt.template);
  const template = readFileSync(templatePath, 'utf-8');
  const skills = scenario.skillsFolder
    ? [...loadSkillsFromFolder(resolveFrom(baseDir, scenario.skillsFolder)).values()]
    : [];
  const enabledTools = scenario.enabledTools
    ?? (scenario.skillsFolder ? ['send_message', 'dismiss_message', 'load_skill'] : ['send_message', 'dismiss_message']);
  const params = {
    modelName: endpoint.model,
    currentChannel: 'telegram',
    hasLoadSkillTool: enabledTools.includes('load_skill') && skills.length > 0,
    hasSubagentTools: false,
    availableSkills: skills.map(s => ({
      id: s.name,
      ...(s.format === 'custom-v2' && s.title ? { title: s.title } : {}),
      description: s.description,
      usage: s.usage,
    })),
    ...prompt.params,
    systemFiles: loadSystemFiles(prompt.systemFiles, baseDir),
  };
  return await renderPromptTemplate(template, params, PACKAGE_BASE_PATH);
};

const buildEntries = async (
  fixture: LoadedEvalFixture,
  endpoint: LlmEndpoint,
  scenario: EvalScenario,
  suite: EvalSuite,
): Promise<ConversationEntry[]> => {
  const rc = render(fixture.ic, scenario.renderParams ?? {});
  const maxTokens = scenario.maxContextEstTokens ?? suite.maxContextEstTokens ?? 200_000;
  const context = composeContext(rc, fixture.turnResponses ?? [], maxTokens, endpoint.model, fixture.compactSummary);
  const entries = context?.entries ? [...context.entries] : [];

  if (scenario.lateBinding !== false) {
    const lateBinding = await renderLateBindingPrompt({
      timeNow: scenario.lateBinding?.timeNow ?? new Date().toISOString(),
      isProbeEnabled: scenario.lateBinding?.isProbeEnabled,
      isProbing: scenario.lateBinding?.isProbing,
      isMentioned: scenario.lateBinding?.isMentioned,
      isReplied: scenario.lateBinding?.isReplied,
      recentSendMessageHumanLikenessXml: scenario.lateBinding?.recentSendMessageHumanLikenessXml,
      activeBackgroundTasks: scenario.lateBinding?.activeBackgroundTasks,
      isInterrupted: scenario.lateBinding?.isInterrupted,
    });
    injectLateBindingPrompt(entries, lateBinding);
  }

  return entries;
};

const resolveScenarioModel = (
  suite: EvalSuite,
  scenario: EvalScenario,
  resolveModel: (name: string) => LlmEndpoint,
): LlmEndpoint => {
  const model = scenario.model ?? suite.model;
  return typeof model === 'string' ? resolveModel(model) : model;
};

const errorEvaluation = (message: string) => ({
  passed: false,
  score: 0,
  labels: { error: true },
  notes: message,
});

const runOne = async (params: {
  suite: EvalSuite;
  scenario: EvalScenario;
  prompt: EvalPromptVariant;
  icName: string;
  fixture: LoadedEvalFixture;
  repeatIndex: number;
  endpoint: LlmEndpoint;
  evaluator: EvalEvaluator;
  baseDir: string;
  log: Logger;
}): Promise<EvalRunResult> => {
  const requestedAtMs = Date.now();
  const entries = await buildEntries(params.fixture, params.endpoint, params.scenario, params.suite);
  const system = await loadPrompt(params.prompt, params.endpoint, params.scenario, params.baseDir);
  const evalTools = createEvalTools({
    skillsFolder: params.scenario.skillsFolder ? resolveFrom(params.baseDir, params.scenario.skillsFolder) : undefined,
    enabledTools: params.scenario.enabledTools,
  });
  const extraTools = await params.scenario.extraTools?.({
    suite: params.suite,
    scenario: params.scenario,
    prompt: params.prompt,
    icName: params.icName,
    repeatIndex: params.repeatIndex,
    log: params.log,
  });
  const tools: CahciuaTool[] = [...evalTools.tools, ...(extraTools ?? [])];
  const stepEntries: ConversationEntry[] = [];
  let usage = { ...ZERO_USAGE };

  try {
    const runner = createRunner(params.endpoint);
    await runner.runStepLoop({
      chatId: `${params.suite.name}:${params.scenario.name}:${params.icName}:${params.prompt.name}`,
      entries,
      system,
      tools,
      maxSteps: params.scenario.maxSteps ?? params.suite.maxSteps ?? 4,
      onStepComplete: (newEntries, stepUsage) => {
        stepEntries.push(...newEntries);
        usage = {
          inputTokens: usage.inputTokens + stepUsage.inputTokens,
          outputTokens: usage.outputTokens + stepUsage.outputTokens,
          cacheCreationTokens: usage.cacheCreationTokens + stepUsage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens + stepUsage.cacheReadTokens,
        };
      },
      checkInterrupt: () => false,
      log: params.log,
      maxImagesAllowed: params.endpoint.maxImagesAllowed,
    });

    const completedAtMs = Date.now();
    const run: EvalRun = {
      suiteName: params.suite.name,
      scenarioName: params.scenario.name,
      icName: params.icName,
      promptName: params.prompt.name,
      repeatIndex: params.repeatIndex,
      modelName: params.endpoint.model,
      system,
      entries,
      stepEntries,
      toolCalls: extractToolCalls(stepEntries),
      toolTrace: evalTools.trace,
      usage,
      requestedAtMs,
      completedAtMs,
    };
    const evaluation = await params.evaluator(run);
    return { ...run, evaluation };
  } catch (err) {
    const completedAtMs = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    const run: EvalRun = {
      suiteName: params.suite.name,
      scenarioName: params.scenario.name,
      icName: params.icName,
      promptName: params.prompt.name,
      repeatIndex: params.repeatIndex,
      modelName: params.endpoint.model,
      system,
      entries,
      stepEntries,
      toolCalls: extractToolCalls(stepEntries),
      toolTrace: evalTools.trace,
      usage,
      requestedAtMs,
      completedAtMs,
      error: message,
    };
    return { ...run, evaluation: errorEvaluation(message) };
  }
};

export const runEvalSuite = async (params: {
  suite: EvalSuite;
  suitePath: string;
  resolveModel: (name: string) => LlmEndpoint;
  log: Logger;
}): Promise<{ results: EvalRunResult[]; outputDir: string }> => {
  const baseDir = dirname(params.suitePath);
  const outputDir = params.suite.outputDir
    ? resolveFrom(baseDir, params.suite.outputDir)
    : join(process.cwd(), 'eval-results', params.suite.name, new Date().toISOString().replace(/[:.]/g, '-'));
  const results: EvalRunResult[] = [];

  for (const scenario of params.suite.scenarios) {
    const endpoint = resolveScenarioModel(params.suite, scenario, params.resolveModel);
    const evaluator = await loadEvaluator(scenario.evaluator, baseDir);
    const contexts = await loadIcSources(scenario.ic, baseDir);
    const repeats = scenario.repeats ?? params.suite.repeats ?? 1;

    for (const ic of contexts) {
      for (const prompt of scenario.prompts) {
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
          params.log.withFields({
            suite: params.suite.name,
            scenario: scenario.name,
            ic: ic.name,
            prompt: prompt.name,
            repeatIndex,
          }).log('Running eval condition');
          const result = await runOne({
            suite: params.suite,
            scenario,
            prompt,
            icName: ic.name,
            fixture: ic,
            repeatIndex,
            endpoint,
            evaluator,
            baseDir,
            log: params.log,
          });
          results.push(result);
        }
      }
    }
  }

  writeEvalReport(params.suite.name, results, outputDir);
  return { results, outputDir };
};
