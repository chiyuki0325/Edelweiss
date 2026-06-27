import { describe, expect, it, vi } from 'vitest';

import { createGroupMemberCache } from './server';
import type { CanonicalUser } from '../adaption-types';
import { redactSecrets, registerHttpSecret } from '../http';

const makeUser = (id: string, displayName: string): CanonicalUser => ({
  id,
  displayName,
  isBot: false,
});

describe('createGroupMemberCache', () => {
  it('dedups concurrent lookups of the same key into one fetch', async () => {
    let resolveFetch: (u: CanonicalUser) => void = () => {};
    const fetcher = vi.fn(() => new Promise<CanonicalUser>(resolve => { resolveFetch = resolve; }));
    const cache = createGroupMemberCache(fetcher);

    const p1 = cache.get('g1', 'u1');
    const p2 = cache.get('g1', 'u1');
    resolveFetch(makeUser('u1', 'Alice'));

    expect(await p1).toEqual(makeUser('u1', 'Alice'));
    expect(await p2).toEqual(makeUser('u1', 'Alice'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves cached entries without re-fetching until the TTL expires', async () => {
    let nowMs = 1_000;
    const fetcher = vi.fn(async (_g: string, u: string) => makeUser(u, `name-${u}`));
    const cache = createGroupMemberCache(fetcher, { ttlMs: 100, now: () => nowMs });

    await cache.get('g1', 'u1');
    await cache.get('g1', 'u1');
    expect(fetcher).toHaveBeenCalledTimes(1);

    nowMs += 50; // still within TTL
    await cache.get('g1', 'u1');
    expect(fetcher).toHaveBeenCalledTimes(1);

    nowMs += 100; // past TTL → refresh
    await cache.get('g1', 'u1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entries past the cap', async () => {
    const fetcher = vi.fn(async (_g: string, u: string) => makeUser(u, `name-${u}`));
    const cache = createGroupMemberCache(fetcher, { maxSize: 2 });

    await cache.get('g', 'a');
    await cache.get('g', 'b');
    // Touch 'a' so 'b' becomes the LRU entry.
    await cache.get('g', 'a');
    // Insert 'c' → exceeds cap → 'b' evicted.
    await cache.get('g', 'c');
    expect(fetcher).toHaveBeenCalledTimes(3);

    // 'a' and 'c' are still cached; 'b' must be re-fetched.
    await cache.get('g', 'a');
    await cache.get('g', 'c');
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cache.get('g', 'b');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not cache a rejected fetch and retries on the next call', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('rpc failed'))
      .mockResolvedValueOnce(makeUser('u1', 'Alice'));
    const cache = createGroupMemberCache(fetcher);

    await expect(cache.get('g1', 'u1')).rejects.toThrow('rpc failed');
    expect(await cache.get('g1', 'u1')).toEqual(makeUser('u1', 'Alice'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('redactSecrets', () => {
  it('masks registered secrets with an equal-length run of asterisks', () => {
    const token = `onebot-secret-${Math.random().toString(36).slice(2)}`;
    registerHttpSecret(token);

    const masked = redactSecrets(`Cannot download file from https://h/?token=${token}`);
    expect(masked).not.toContain(token);
    expect(masked).toContain('*'.repeat(token.length));
  });
});
