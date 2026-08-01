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
    imageToText: { enabled: false, compress: false, pixelBudget: 0 },
  } as ResolvedChatConfig,
  allSkills: new Map(),
  runtimeConfig: runtime,
  loadMessageAttachments: () => undefined,
  downloadFile: async () => Buffer.alloc(0),
  sendMessage,
  resolveModel: () => { throw new Error('unused'); },
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
