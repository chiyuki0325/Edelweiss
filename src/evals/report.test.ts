import { describe, expect, it } from 'vitest';

import { summarizeEvalRuns } from './report';
import type { EvalRunResult } from './types';

const run = (promptName: string, passed: boolean, labels = {}): EvalRunResult => ({
  suiteName: 'suite',
  scenarioName: 'scenario',
  icName: 'ic',
  promptName,
  repeatIndex: 0,
  modelName: 'model',
  system: 'system',
  entries: [],
  stepEntries: [],
  toolCalls: [],
  toolTrace: { loadedSkills: [], sentMessages: [] },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  requestedAtMs: 100,
  completedAtMs: 150,
  evaluation: {
    passed,
    score: passed ? 1 : 0,
    labels,
  },
});

describe('summarizeEvalRuns', () => {
  it('groups runs by condition and computes rates', () => {
    const summary = summarizeEvalRuns('suite', [
      run('baseline', true, { calledSkill: true }),
      run('baseline', false, { calledSkill: false }),
      run('aggressive', true, { calledSkill: true }),
    ]);

    expect(summary.runs).toBe(3);
    expect(summary.conditions).toHaveLength(2);
    const baseline = summary.conditions.find(c => c.promptName === 'baseline')!;
    expect(baseline.repeats).toBe(2);
    expect(baseline.passRate).toBe(0.5);
    expect(baseline.averageScore).toBe(0.5);
    expect(baseline.averageInputTokens).toBe(10);
    expect(baseline.averageLatencyMs).toBe(50);
    expect(baseline.labelRates.calledSkill).toBe(0.5);
    expect(baseline.passWilsonLow).toBeGreaterThanOrEqual(0);
    expect(baseline.passWilsonHigh).toBeLessThanOrEqual(1);
  });
});
