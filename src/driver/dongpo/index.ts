interface DongpoModel {
  format: string;
  format_version: number;
  features: string[];
  idf: number[];
  coefficients: number[];
  intercept: number;
  threshold: number;
  ngram_range: number[];
  lowercase: boolean;
  sublinear_tf: boolean;
}

const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const blank = new RegExp(`^${whitespace}*$`, 'u');
const repeatedWhitespace = new RegExp(`${whitespace}{2,}`, 'gu');
const gate = /[不但仅凭只尚却]|无法|更准确/u;

export const createDongpoJudge = (model: DongpoModel) => {
  if (model.format !== 'dongpo-judge-char-tfidf-lr' || model.format_version !== 1)
    throw new Error('不支持的模型格式');
  if (model.features.length !== model.idf.length || model.features.length !== model.coefficients.length)
    throw new Error('模型特征维度不一致');

  const vocabulary = new Map(model.features.map((feature, index) => [feature, index]));

  const score = (text: string): number => {
    if (typeof text !== 'string' || blank.test(text))
      throw new Error('输入必须包含非空文本');

    const normalized = (model.lowercase ? text.toLowerCase() : text).replace(repeatedWhitespace, ' ');
    const characters = Array.from(normalized);
    const counts = new Map<number, number>();
    const minNgram = model.ngram_range[0]!;
    const maxNgram = model.ngram_range[1]!;
    for (let size = minNgram; size <= Math.min(maxNgram, characters.length); size++) {
      for (let offset = 0; offset <= characters.length - size; offset++) {
        const feature = characters.slice(offset, offset + size).join('');
        const index = vocabulary.get(feature);
        if (index !== undefined)
          counts.set(index, (counts.get(index) ?? 0) + 1);
      }
    }

    let squaredNorm = 0;
    const values = [...counts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, count]): [number, number] => {
        const value = (model.sublinear_tf ? 1 + Math.log(count) : count) * model.idf[index]!;
        squaredNorm += value * value;
        return [index, value];
      });
    const norm = Math.sqrt(squaredNorm);
    let decision = model.intercept;
    for (const [index, value] of values)
      decision += (value / norm) * model.coefficients[index]!;

    if (decision >= 0)
      return 1 / (1 + Math.exp(-decision));
    const exponential = Math.exp(decision);
    return exponential / (1 + exponential);
  };

  return { score, threshold: model.threshold };
};

let judgePromise: Promise<ReturnType<typeof createDongpoJudge>> | undefined;

export const loadDongpoJudge = () => judgePromise ??= import('./model.json')
  .then(({ default: model }) => createDongpoJudge(model));

export const detectDongpo = async (text: string): Promise<boolean> => {
  if (!gate.test(text))
    return false;
  const judge = await loadDongpoJudge();
  const tail = Array.from(text).slice(-120).join('');
  return judge.score(tail) > judge.threshold;
};
