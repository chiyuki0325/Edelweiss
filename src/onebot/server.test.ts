import { useLogger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createFriendRemarkCache, createGroupMemberCache, createOneBotServer } from './server';
import type { OneBotConfig } from './types';
import type { CanonicalUser } from '../adaption-types';
import { redactSecrets, registerHttpSecret } from '../http';

const connectedClients = new Set<WebSocket>();

afterEach(() => {
  for (const client of connectedClients) client.terminate();
  connectedClients.clear();
});

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

describe('createFriendRemarkCache', () => {
  it('loads friend remarks once and serves users from the cache', async () => {
    const fetcher = vi.fn(async () => [
      { user_id: 1, remark: '好友备注' },
      { user_id: 2, remark: '' },
    ]);
    const cache = createFriendRemarkCache(fetcher);

    expect(await cache.get('1')).toBe('好友备注');
    expect(await cache.get('2')).toBeUndefined();
    expect(await cache.get('3')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent refreshes and reloads after expiry', async () => {
    let nowMs = 1000;
    let resolveFetch: (friends: Array<{ user_id: number; remark?: string }>) => void = () => {};
    const fetcher = vi.fn(() => new Promise<Array<{ user_id: number; remark?: string }>>(resolve => {
      resolveFetch = resolve;
    }));
    const cache = createFriendRemarkCache(fetcher, { ttlMs: 100, now: () => nowMs });

    const first = cache.get('1');
    const second = cache.get('2');
    resolveFetch([{ user_id: 1, remark: '备注一' }]);
    expect(await first).toBe('备注一');
    expect(await second).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();

    nowMs += 101;
    const refreshed = cache.get('1');
    resolveFetch([{ user_id: 1, remark: '备注二' }]);
    expect(await refreshed).toBe('备注二');
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

describe('createOneBotServer', () => {
  const connect = async (port: number): Promise<WebSocket> => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    connectedClients.add(client);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return client;
  };

  it('keeps the newest API when an older WebSocket closes', async () => {
    const server = createOneBotServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      accessToken: '',
    }, {
      onEvent: () => {},
      log: useLogger('onebot-server-test'),
    });
    await server.start();
    const port = typeof server.address === 'object' ? server.address?.port : undefined;
    expect(port).toBeTypeOf('number');

    const olderClient = await connect(port!);
    const olderApi = server.api;
    const newerClient = await connect(port!);
    const newerApi = server.api;
    expect(newerApi).not.toBe(olderApi);

    const olderClosed = new Promise<void>(resolve => olderClient.once('close', () => resolve()));
    olderClient.terminate();
    await olderClosed;
    expect(server.api).toBe(newerApi);

    newerClient.terminate();
    await server.stop();
  });

  it('stops while a WebSocket client is still connected', async () => {
    const config: OneBotConfig = {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      accessToken: '',
    };
    const server = createOneBotServer(config, {
      onEvent: () => {},
      log: useLogger('onebot-server-test'),
    });

    await server.start();

    expect(server.address).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    const port = typeof server.address === 'object' ? server.address?.port : undefined;

    const client = await connect(port!);

    const clientClosed = new Promise<void>(resolve => client.once('close', () => resolve()));
    await expect(server.stop()).resolves.toBeUndefined();
    await clientClosed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
