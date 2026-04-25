import { describe, expect, it } from 'vitest';

import { ensureDeepSeekThinkingBlocks } from './streaming-anthropic';

describe('ensureDeepSeekThinkingBlocks', () => {
  it('injects empty thinking block for deepseek assistant messages without thinking', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    ] as any;

    const result = ensureDeepSeekThinkingBlocks('deepseek-v4-pro', messages);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Let me check.' },
      ],
    });
  });

  it('does not inject when assistant already has thinking', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'tool_use', id: 'tc1', name: 'fn', input: {} }] },
    ] as any;

    const result = ensureDeepSeekThinkingBlocks('deepseek-v4-pro', messages);
    expect(result).toEqual(messages);
  });

  it('does nothing for non-deepseek models', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ] as any;

    const result = ensureDeepSeekThinkingBlocks('claude-3-7-sonnet', messages);
    expect(result).toEqual(messages);
  });
});
