import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  EvalConditionSummary,
  EvalRunResult,
  EvalSuiteSummary,
} from './types';

const conditionKey = (run: EvalRunResult): string =>
  `${run.suiteName}\0${run.scenarioName}\0${run.icName}\0${run.promptName}`;

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

const wilsonInterval = (successes: number, total: number, z = 1.96): { low: number; high: number } => {
  if (total === 0) return { low: 0, high: 0 };
  const phat = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
};

export const summarizeEvalRuns = (suiteName: string, runs: EvalRunResult[]): EvalSuiteSummary => {
  const groups = new Map<string, EvalRunResult[]>();
  for (const run of runs) {
    const key = conditionKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const conditions: EvalConditionSummary[] = [...groups.values()].map(group => {
    const first = group[0]!;
    const completed = group.filter(run => !run.error);
    const passCount = completed.filter(run => run.evaluation.passed).length;
    const interval = wilsonInterval(passCount, completed.length);
    const scores = completed
      .map(run => run.evaluation.score)
      .filter((score): score is number => typeof score === 'number');
    const labelKeys = new Set<string>();
    for (const run of completed)
      for (const key of Object.keys(run.evaluation.labels ?? {}))
        labelKeys.add(key);

    const labelRates: Record<string, number> = {};
    for (const key of labelKeys) {
      const numeric = completed
        .map(run => run.evaluation.labels?.[key])
        .filter((value): value is boolean | number => typeof value === 'boolean' || typeof value === 'number')
        .map(value => typeof value === 'boolean' ? (value ? 1 : 0) : value);
      labelRates[key] = mean(numeric);
    }

    return {
      suiteName: first.suiteName,
      scenarioName: first.scenarioName,
      icName: first.icName,
      promptName: first.promptName,
      repeats: group.length,
      failures: group.length - completed.length,
      passRate: completed.length === 0 ? 0 : passCount / completed.length,
      passWilsonLow: interval.low,
      passWilsonHigh: interval.high,
      averageScore: scores.length === 0 ? null : mean(scores),
      averageInputTokens: mean(completed.map(run => run.usage.inputTokens)),
      averageOutputTokens: mean(completed.map(run => run.usage.outputTokens)),
      averageLatencyMs: mean(completed.map(run => run.completedAtMs - run.requestedAtMs)),
      labelRates,
    };
  });

  conditions.sort((a, b) =>
    a.scenarioName.localeCompare(b.scenarioName)
    || a.icName.localeCompare(b.icName)
    || a.promptName.localeCompare(b.promptName));

  return {
    suiteName,
    generatedAt: new Date().toISOString(),
    runs: runs.length,
    conditions,
  };
};

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value === 'object' && value !== null && 'constructor' in value) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'Sharp') return '[Sharp image]';
  }
  return value;
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const renderMarkdownSummary = (summary: EvalSuiteSummary): string => {
  const lines = [
    `# ${summary.suiteName}`,
    '',
    `Generated at: ${summary.generatedAt}`,
    '',
    '| scenario | ic | prompt | repeats | failures | pass_rate | 95% CI | avg_score | avg_input | avg_output | avg_latency_ms | labels |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const c of summary.conditions) {
    const labels = Object.entries(c.labelRates)
      .map(([key, value]) => `${key}=${pct(value)}`)
      .join(', ');
    lines.push([
      c.scenarioName,
      c.icName,
      c.promptName,
      String(c.repeats),
      String(c.failures),
      pct(c.passRate),
      `${pct(c.passWilsonLow)}..${pct(c.passWilsonHigh)}`,
      c.averageScore == null ? '' : c.averageScore.toFixed(3),
      c.averageInputTokens.toFixed(0),
      c.averageOutputTokens.toFixed(0),
      c.averageLatencyMs.toFixed(0),
      labels,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  return `${lines.join('\n')}\n`;
};

export const writeEvalReport = (
  suiteName: string,
  runs: EvalRunResult[],
  outputDir: string,
): EvalSuiteSummary => {
  mkdirSync(outputDir, { recursive: true });
  const summary = summarizeEvalRuns(suiteName, runs);
  writeFileSync(
    join(outputDir, 'runs.jsonl'),
    runs.map(run => JSON.stringify(run, jsonReplacer)).join('\n') + (runs.length > 0 ? '\n' : ''),
  );
  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outputDir, 'summary.md'), renderMarkdownSummary(summary));
  return summary;
};
