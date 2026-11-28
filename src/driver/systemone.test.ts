import type { Logger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefensiveWritingDetector, selectWritingReviewContext } from './systemone';
import type { RenderedContext } from '../rendering/types';

const config = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey: 'test-key',
  model: 'jev-latest',
  threshold: 0.55,
};
const log = { warn: vi.fn(), withFields() { return this; } } as unknown as Logger;
const detect = createDefensiveWritingDetector(config, log);
const answer = (noul: unknown) => Response.json({ answers: { is_defensive_writing: { type: 'noul', noul } } });

afterEach(() => vi.restoreAllMocks());

describe('System One defensive writing detector', () => {
  it('checks admission on the entire draft and posts it untruncated to the official endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(0.8));
    const text = `不能确定\n${'甲'.repeat(150)}`;
    expect(await detect(text)).toBe('defensive');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'jev-latest',
      state: text,
      questions: {
        is_defensive_writing: {
          type: 'noul',
          instructions: expect.stringContaining('Does this GPT response contain defensive writing?\nExamples:'),
        },
      },
    });
  });

  it('sends requests to the configured endpoint with the configured model', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(0.8));
    const endpoint = 'https://systemone.example/v1/systemone';
    const model = 'mili_debug/Clef';
    const detectCustom = createDefensiveWritingDetector({ ...config, endpoint, model }, log);
    expect(await detectCustom('更准确的说法')).toBe('defensive');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(JSON.parse(init?.body as string).model).toBe(model);
  });

  it('sends both approved questions in one request when context is available', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      answers: {
        is_defensive_writing: { type: 'noul', noul: 0.34 },
        is_uninvited_reply: { type: 'noul', noul: 0.79 },
      },
    }));
    const draft = '光看均速不能判断有没有出汗';
    const context = '对方分享了一张骑车记录截图';
    expect(await detect(draft, context)).toBe('uninvited');
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({
      model: 'jev-latest',
      state: { context, draft },
      questions: {
        is_defensive_writing: {
          type: 'noul',
          instructions: 'Does this GPT response contain defensive writing?\nExamples: “But it doesn’t mean that …”, “But I can’t claim that …”, “We cannot deduct the result that …”\n\nJudge the wording of draft only. Do not use context to excuse or penalize its wording.',
        },
        is_uninvited_reply: {
          type: 'noul',
          instructions: '结合context，这条draft是否在回答一个没人问、也没必要主动回答的问题，或纠正一个没人提出、也不妨碍交流的判断？\n\n如果草稿无视context分享的内容，自顾自地开始纠正、考证或告诫，答是。\n如果草稿在回答实际问题，或自然地接住了对方分享的内容，答否。',
        },
      },
    });
  });

  it.each([
    [0.55, 0.55, null],
    [0.56, 0.55, 'defensive'],
    [0.56, 0.56, 'uninvited'],
    [0.56, '0.9', 'defensive'],
    [1.2, 0.56, 'uninvited'],
  ])('scores both answers independently (%s, %s)', async (defensive, uninvited, verdict) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      answers: {
        is_defensive_writing: { type: 'noul', noul: defensive },
        is_uninvited_reply: { type: 'noul', noul: uninvited },
      },
    }));
    expect(await detect('不能确定', '前文')).toBe(verdict);
  });

  it.each([0.1645164628965632, 0.55, -1, 1.2, '0.8', undefined])('does not flag a low or invalid score (%s)', async score => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(score));
    expect(await detect('不能确定')).toBeNull();
  });

  it('skips drafts that miss the old keyword gate, even if context matches', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await detect('服务恢复了', '但你之前说无法连接')).toBeNull();
    expect(await detect('  ')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails open on HTTP, JSON, and network errors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('not JSON'))
      .mockRejectedValueOnce(new Error('network failure'));
    for (let i = 0; i < 3; i++)
      expect(await detect('不能确定')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

it('prefers an explicit reply target, otherwise uses the three newest incoming messages after the cutoff', () => {
  const messages: RenderedContext = Array.from({ length: 7 }, (_, i) => ({
    receivedAtMs: i,
    messageId: i === 6 ? undefined : String(i),
    isMyself: i === 5,
    content: [{ type: 'text', text: i === 0 ? '甲'.repeat(2_001) : `消息 ${i}` }],
  }));
  expect(selectWritingReviewContext(messages, 0)).toBe('消息 2\n消息 3\n消息 4');
  expect(selectWritingReviewContext(messages, 0, '0')).toBe('甲'.repeat(2_000));
  expect(selectWritingReviewContext(messages, 0, 'missing')).toBe('');
});
