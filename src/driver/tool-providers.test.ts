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
    tools: { bash: { backgroundThresholdSec: 10, compactOutput: false }, webSearch: { tavilyKey: '' } },
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
