import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, resolveChatConfig } from './config';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

const loadFixture = (chats: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}) => {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
    models: { primary: { apiBaseUrl: '', apiKey: '', model: 'test', ...endpoint } },
    runtime: { writeFile: ['tee'], readFile: ['cat'] },
    chats: { default: { tools: { webSearch: { tavilyKey: 'test' } } }, ...chats },
  }));
  return loadConfig();
};

beforeEach(() => vi.clearAllMocks());

describe('dongpo review config', () => {
  it('defaults to enabled and supports per-chat overrides', () => {
    const config = loadFixture({ a: { humanLikeness: { notDongpo: false } } });
    expect(resolveChatConfig(config, 'other').humanLikeness.notDongpo).toBe(true);
    expect(resolveChatConfig(config, 'a').humanLikeness.notDongpo).toBe(false);
  });

  it('inherits a disabled default and supports explicitly enabling a chat', () => {
    const config = loadFixture({
      default: { humanLikeness: { notDongpo: false }, tools: { webSearch: { tavilyKey: 'test' } } },
      a: { humanLikeness: { notDongpo: true } },
    });
    expect(resolveChatConfig(config, 'other').humanLikeness.notDongpo).toBe(false);
    expect(resolveChatConfig(config, 'a').humanLikeness.notDongpo).toBe(true);
    expect(() => loadFixture({ a: { humanLikeness: { notDongpo: 'true' } } })).toThrow();
  });
});

describe('disabledReactions config', () => {
  it('defaults to the disabled list without a config entry', () => {
    expect(resolveChatConfig(loadFixture(), 'chat').disabledReactions).toEqual(['😁', '🖕', '😇']);
  });

  it('replaces rather than index-merges per-chat lists, including empty lists', () => {
    const config = loadFixture({ a: { disabledReactions: ['👍'] }, b: { disabledReactions: [] } });
    expect(resolveChatConfig(config, 'a').disabledReactions).toEqual(['👍']);
    expect(resolveChatConfig(config, 'b').disabledReactions).toEqual([]);
    expect(resolveChatConfig(config, 'other').disabledReactions).toEqual(['😁', '🖕', '😇']);
    expect(config.chats.default.disabledReactions).toEqual(['😁', '🖕', '😇']);
  });

  it('inherits a configured default and validates overrides', () => {
    const config = loadFixture({ default: { disabledReactions: ['❤️'], tools: { webSearch: { tavilyKey: 'test' } } } });
    expect(resolveChatConfig(config, 'chat').disabledReactions).toEqual(['❤️']);
    expect(() => loadFixture({ a: { disabledReactions: [42] } })).toThrow();
  });
});

describe('tool selection config', () => {
  it('defaults to automatic selection and three local-force retries', () => {
    const endpoint = loadFixture().models.primary!;
    expect(endpoint.toolChoice).toBeUndefined();
    expect(endpoint.localForceMaxRetries).toBe(3);
  });

  it.each(['force', 'local-force', 'none', 'local-none'])('accepts toolChoice %s', toolChoice => {
    expect(loadFixture({}, { toolChoice }).models.primary!.toolChoice).toBe(toolChoice);
  });

  it.each([0, 5])('accepts %s local-force retries', localForceMaxRetries => {
    expect(loadFixture({}, { localForceMaxRetries }).models.primary!.localForceMaxRetries).toBe(localForceMaxRetries);
  });

  it.each([-1, 1.5, '3'])('rejects invalid retry limit %s', localForceMaxRetries => {
    expect(() => loadFixture({}, { localForceMaxRetries })).toThrow();
  });
});
