import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelFixture = () => ({
  format: 'dongpo-judge-char-tfidf-lr',
  format_version: 1,
  features: ['不', '😀', 'a b'],
  idf: [1, 2, 1],
  coefficients: [2, -1, 3],
  intercept: 0,
  threshold: 0.5,
  ngram_range: [1, 3],
  lowercase: true,
  sublinear_tf: true,
});

const loadModel = vi.fn();

beforeEach(() => {
  vi.resetModules();
  loadModel.mockReset();
  vi.doMock('./model.json', () => {
    loadModel();
    return { default: modelFixture() };
  });
});

describe('dongpo judge', () => {
  it('does not load the model for text outside the keyword gate', async () => {
    const { detectDongpo } = await import('./index');
    expect(await detectDongpo('服务已经恢复了')).toBe(false);
    expect(await detectDongpo('')).toBe(false);
    expect(loadModel).not.toHaveBeenCalled();
  });

  it('shares one model and judge across concurrent calls and later turns', async () => {
    const { detectDongpo, loadDongpoJudge } = await import('./index');
    const [first, second] = await Promise.all([loadDongpoJudge(), loadDongpoJudge()]);
    expect(first).toBe(second);
    expect(await Promise.all([detectDongpo('不能'), detectDongpo('不行')])).toEqual([true, true]);
    expect(await loadDongpoJudge()).toBe(first);
    expect(loadModel).toHaveBeenCalledOnce();
  });

  it.each(['不', '但', '仅', '凭', '只', '尚', '却', '无法', '更准确'])('runs inference after the %s keyword gate', async text => {
    const { detectDongpo } = await import('./index');
    await detectDongpo(text);
    expect(loadModel).toHaveBeenCalledOnce();
  });

  it('uses a strict threshold and scores only the last 120 Unicode code points', async () => {
    const { detectDongpo, loadDongpoJudge } = await import('./index');
    const score = vi.spyOn(await loadDongpoJudge(), 'score');
    expect(await detectDongpo('不')).toBe(true);
    expect(await detectDongpo(`不${'😀'.repeat(120)}`)).toBe(false);
    expect(score).toHaveBeenLastCalledWith('😀'.repeat(120));
    await detectDongpo(`不${'😀'.repeat(119)}`);
    expect(score).toHaveBeenLastCalledWith(`不${'😀'.repeat(119)}`);
    expect(await detectDongpo(`不${'好'.repeat(120)}`)).toBe(false);
  });

  it('preserves Unicode features, lowercasing, whitespace normalization, and bias fallback', async () => {
    const { createDongpoJudge } = await import('./index');
    const judge = createDongpoJudge(modelFixture());
    expect(judge.score('不')).toBeCloseTo(1 / (1 + Math.exp(-2)), 14);
    expect(judge.score('😀')).toBeCloseTo(1 / (1 + Math.exp(1)), 14);
    expect(judge.score('A  B')).toBeCloseTo(1 / (1 + Math.exp(-3)), 14);
    expect(judge.score('A\nB')).toBe(0.5);
    expect(judge.score('词表外')).toBe(0.5);
    expect(() => judge.score('\u0085 \t')).toThrow('非空文本');
  });

  it('preserves sublinear TF, IDF, L2 normalization, and model validation', async () => {
    const { createDongpoJudge } = await import('./index');
    const judge = createDongpoJudge(modelFixture());
    const firstValue = 1 + Math.log(2);
    const secondValue = 2;
    const decision = (firstValue * 2 - secondValue) / Math.sqrt(firstValue ** 2 + secondValue ** 2);
    expect(judge.score('不不😀')).toBeCloseTo(1 / (1 + Math.exp(-decision)), 14);
    expect(() => createDongpoJudge({ ...modelFixture(), format_version: 2 })).toThrow('模型格式');
    expect(() => createDongpoJudge({ ...modelFixture(), idf: [] })).toThrow('维度不一致');
  });
});
