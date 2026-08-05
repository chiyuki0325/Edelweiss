import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebFetcher, substituteWebFetchHost } from './index';
import type { WebFetchConfig } from './types';

const config: WebFetchConfig = { provider: 'jina', jina: { apiKey: '' } };

afterEach(() => vi.unstubAllGlobals());

describe('web fetch routing', () => {
  it('substitutes exact X/Twitter hosts while preserving the rest of the URL', () => {
    expect(substituteWebFetchHost('https://www.x.com/user/status/1?lang=en#post'))
      .toBe('https://i.fixupx.com/user/status/1?lang=en#post');
    expect(substituteWebFetchHost('https://mobile.x.com/user/status/1'))
      .toBe('https://mobile.x.com/user/status/1');
  });

  it('returns Instant View without invoking Jina', async () => {
    const fallback = vi.fn();
    vi.stubGlobal('fetch', fallback);
    const instantView = { fetch: vi.fn(async () => ({ title: 'Tweet', content: 'IV markdown' })) };
    const fetcher = createWebFetcher(config, { instantView });

    await expect(fetcher.fetch('https://x.com/user/status/1')).resolves.toEqual({
      url: 'https://x.com/user/status/1',
      title: 'Tweet',
      content: 'IV markdown',
    });
    expect(instantView.fetch).toHaveBeenCalledWith('https://i.fixupx.com/user/status/1');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to Jina with the substituted URL but reports the requested URL', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(JSON.stringify({
      code: 200,
      data: { title: 'Fallback', url: 'https://i.fixupx.com/user/status/1', content: 'Jina markdown' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = createWebFetcher(config, { instantView: { fetch: async () => undefined } });

    await expect(fetcher.fetch('https://x.com/user/status/1')).resolves.toEqual({
      url: 'https://x.com/user/status/1',
      title: 'Fallback',
      content: 'Jina markdown',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://r.jina.ai/https://i.fixupx.com/user/status/1');
  });
});
