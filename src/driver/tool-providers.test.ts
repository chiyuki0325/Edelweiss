import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { createToolsForCapabilities } from './tool-providers';
import type { CapabilityToolProviderDeps } from './tool-providers';
import { createDefaultTurnCapabilities } from './turn-state';
import type { ResolvedChatConfig, RuntimeConfig } from '../config/config';

const runtime: RuntimeConfig = {
  shell: ['sh', '-c'],
  writeFile: ['tee'],
  readFile: ['cat'],
  writeFileSizeLimit: 1024,
  readFileSizeLimit: 1024,
};

const deps = (platform: 'telegram' | 'onebot', sendMessage: CapabilityToolProviderDeps['sendMessage']): CapabilityToolProviderDeps => ({
  chatId: '100',
  chatConfig: {
    platform,
    identityName: 'Edelweiss',
    tools: { bash: { backgroundThresholdSec: 10, compactOutput: false }, webSearch: { tavilyKey: '' } },
    humanLikeness: {
      trailingPeriod: true,
      denseClausePunctuation: true,
      multipleMarkdownBold: true,
      markdownList: true,
      markdownHeader: true,
      newline: true,
      notErshi: true,
      notQueshi: true,
      notRen: true,
      notDongpo: true,
      reducePersonaWords: {},
    },
    imageToText: { enabled: false, compress: false, pixelBudget: 0, maxContextEstTokens: 200_000 },
  } as ResolvedChatConfig,
  allSkills: new Map(),
  runtimeConfig: runtime,
  loadMessageAttachments: () => undefined,
  downloadFile: async () => Buffer.alloc(0),
  sendMessage,
  resolveModel: () => { throw new Error('unused'); },
  imageConversations: {
    start: async () => { throw new Error('unused'); },
    ask: async () => { throw new Error('unused'); },
  },
  backgroundTask: {
    startTask: () => 1,
    killTask: () => ({ ok: true }),
    readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
  },
  focusMode: (() => false) as CapabilityToolProviderDeps['focusMode'],
  getActiveTurn: () => null,
  log: {
    withFields() { return this; },
    log() {},
  } as unknown as CapabilityToolProviderDeps['log'],
});

describe('createToolsForCapabilities send routing', () => {
  it('refuses Telegram fallback for a OneBot chat without an adapter', async () => {
    const telegramSend = vi.fn(async () => ({ messageId: 1, date: 1 }));
    const capabilities = createDefaultTurnCapabilities('main');
    const tool = createToolsForCapabilities(deps('onebot', telegramSend), capabilities)
      .find(candidate => candidate.function.name === 'send_message')!;

    await expect(tool.execute({ text: 'hello' }, { toolCallId: 'tc1' }))
      .rejects.toThrow('refusing Telegram fallback');
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('starts read_image sessions with the actually rendered low/high prompts', async () => {
    const tinyPng = await (await import('sharp')).default({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    }).png().toBuffer();
    const toolDeps = deps('telegram', vi.fn(async () => ({ messageId: 1, date: 1 })));
    toolDeps.chatConfig.imageToText = {
      enabled: false,
      model: 'vision',
      compress: true,
      pixelBudget: 75_000,
      maxContextEstTokens: 200_000,
    };
    toolDeps.resolveModel = () => ({ apiBaseUrl: 'https://example.test', apiKey: 'key', model: 'vision' });
    toolDeps.loadMessageAttachments = () => [{ type: 'photo', fileId: 'telegram-file' }];
    toolDeps.downloadFile = async () => tinyPng;
    const start = vi.fn(async params => ({ imageId: `img_${params.systemPrompt.length}`, description: 'description', reused: false }));
    toolDeps.imageConversations = { start, ask: vi.fn() } as any;
    const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
      .find(candidate => candidate.function.name === 'read_image')!;

    await tool.execute({ file_id: '1:0', detail: 'low' }, { toolCallId: 'low' });
    await tool.execute({ file_id: '1:0', detail: 'high' }, { toolCallId: 'high' });

    expect(start.mock.calls[0]![0].systemPrompt).toContain('under 100 words');
    expect(start.mock.calls[0]![0].systemPrompt).not.toContain('Transcribe ALL visible text');
    expect(start.mock.calls[1]![0].systemPrompt).toContain('Transcribe ALL visible text verbatim');
    expect(start.mock.calls[0]![0].sourceKey).toContain(':low');
    expect(start.mock.calls[1]![0].sourceKey).toContain(':high');
  });

  it('offers ask_for_image only to the main agent when a vision model is configured', () => {
    const toolDeps = deps('telegram', vi.fn(async () => ({ messageId: 1, date: 1 })));
    toolDeps.chatConfig.imageToText = {
      enabled: false,
      model: 'vision',
      compress: true,
      pixelBudget: 75_000,
      maxContextEstTokens: 200_000,
    };
    toolDeps.resolveModel = () => ({ apiBaseUrl: 'https://example.test', apiKey: 'key', model: 'vision' });

    const mainNames = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
      .map(tool => tool.function.name);
    const subagentNames = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('subagent'))
      .map(tool => tool.function.name);

    expect(mainNames).toContain('ask_for_image');
    expect(subagentNames).not.toContain('ask_for_image');
  });

  it('passes the notErshi toggle to the send boundary filter', async () => {
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1 }));
    const toolDeps = deps('telegram', sendMessage);
    toolDeps.chatConfig.humanLikeness.notErshi = false;
    const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
      .find(candidate => candidate.function.name === 'send_message')!;

    const result = await tool.execute(
      { text: '这不是接口问题，而是模型问题' },
      { toolCallId: 'tc-contrast-disabled' },
    );

    expect(JSON.parse(result.content as string)).toEqual({ ok: true, message_id: '1' });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('passes the notQueshi toggle to the send boundary filter', async () => {
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1 }));
    const toolDeps = deps('telegram', sendMessage);
    toolDeps.chatConfig.humanLikeness.notQueshi = false;
    const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
      .find(candidate => candidate.function.name === 'send_message')!;

    const result = await tool.execute(
      { text: '确实，这里少传了 abort signal' },
      { toolCallId: 'tc-queshi-disabled' },
    );

    expect(JSON.parse(result.content as string)).toEqual({ ok: true, message_id: '1' });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['notRen', '行吧，我认'],
  ] as const)('passes the %s toggle to the send boundary filter', async (toggle, text) => {
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1 }));
    const toolDeps = deps('telegram', sendMessage);
    toolDeps.chatConfig.humanLikeness[toggle] = false;
    const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
      .find(candidate => candidate.function.name === 'send_message')!;

    const result = await tool.execute(
      { text },
      { toolCallId: 'tc-ren-disabled' },
    );

    expect(JSON.parse(result.content as string)).toEqual({ ok: true, message_id: '1' });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it.each([true, false])('only calls configured System One when notDongpo is %s', async enabled => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      answers: { is_defensive_writing: { type: 'noul', noul: 0.9 } },
    }));
    try {
      const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1 }));
      const toolDeps = deps('telegram', sendMessage);
      toolDeps.chatConfig.humanLikeness.notDongpo = enabled;
      toolDeps.chatConfig.systemOne = {
        endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: 'test-key', model: 'jev-latest', threshold: 0.55,
      };
      const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'))
        .find(candidate => candidate.function.name === 'send_message')!;
      const result = await tool.execute({ text: '还不能断定服务恢复了' }, { toolCallId: 'tc-defensive' });
      expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(sendMessage).toHaveBeenCalledTimes(enabled ? 0 : 1);
      expect(JSON.parse(result.content as string)).toMatchObject(enabled
        ? { ok: false, code: 'defensive_review_required' }
        : { ok: true });
    } finally {
      fetch.mockRestore();
    }
  });

  it('reviews the reply target from the turn snapshot with alt text but without image pieces', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      answers: {
        is_defensive_writing: { type: 'noul', noul: 0.34 },
        is_uninvited_reply: { type: 'noul', noul: 0.79 },
      },
    }));
    try {
      const sendMessage = vi.fn(async () => ({ messageId: 1, date: 1 }));
      const toolDeps = deps('telegram', sendMessage);
      toolDeps.chatConfig.systemOne = {
        endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: 'test-key', model: 'jev-latest', threshold: 0.55,
      };
      const context = '<message id="42">\n<image type="photo">一张骑车记录截图</image>\n</message>';
      const tool = createToolsForCapabilities(toolDeps, createDefaultTurnCapabilities('main'), [], undefined, {
        afterMs: 2,
        rc: [
          { receivedAtMs: 1, messageId: '42', content: [{ type: 'text', text: context }, { type: 'image', image: sharp() }] },
          { receivedAtMs: 3, messageId: '43', content: [{ type: 'text', text: '另一条无关消息' }] },
        ],
      }).find(candidate => candidate.function.name === 'send_message')!;
      const draft = '光看均速不能判断有没有出汗';
      const result = await tool.execute({ text: draft, reply_to: '42' }, { toolCallId: 'tc-contextual' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).state).toEqual({ context, draft });
      expect(JSON.parse(result.content as string)).toMatchObject({
        ok: false,
        code: 'defensive_review_required',
        next_actions: { nothing_to_add: { action: 'stay_silent' } },
      });
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('does not suggest react_message when the reaction tool is not assembled', async () => {
    const capabilities = createDefaultTurnCapabilities('main');
    const tool = createToolsForCapabilities(
      deps('onebot', vi.fn(async () => ({ messageId: 1, date: 1 }))),
      capabilities,
      ['👍'],
    ).find(candidate => candidate.function.name === 'send_message')!;

    const result = await tool.execute({ text: '确实' }, { toolCallId: 'tc1' });
    const payload = JSON.parse(result.content as string);

    expect(payload.next_actions.agreement_only.action).toBe('stay_silent');
    expect(result.content).not.toContain('react_message');
  });

  it('suggests react_message when the Telegram reaction tool is assembled', async () => {
    const capabilities = createDefaultTurnCapabilities('main');
    const telegramDeps = deps('telegram', vi.fn(async () => ({ messageId: 1, date: 1 })));
    telegramDeps.sendReaction = vi.fn(async () => {});
    const tool = createToolsForCapabilities(telegramDeps, capabilities, ['👍'])
      .find(candidate => candidate.function.name === 'send_message')!;

    const result = await tool.execute(
      { text: '确实', reply_to: '42' },
      { toolCallId: 'tc1' },
    );
    const payload = JSON.parse(result.content as string);

    expect(payload.next_actions.agreement_only).toMatchObject({
      action: 'react_message',
      suggested_message_id: '42',
    });
  });
});
