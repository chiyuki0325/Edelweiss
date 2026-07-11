import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from '@guiiai/logg';
import { WebSocketServer, type WebSocket } from 'ws';

import { adaptUser, captureOneBotIngressMeta, type OneBotIngressMeta } from './adaptation';
import type {
  OneBotApiRequest,
  OneBotApiResponse,
  OneBotConfig,
  OneBotEvent,
  OneBotGetFileResult,
  OneBotMessageEvent,
  OneBotMessageSegment,
  OneBotNoticeEvent,
} from './types';
import type { CanonicalUser } from '../adaption-types';
import { httpGetBuffer, redactSecrets, registerHttpSecret } from '../http';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Group member info is cached to avoid re-issuing get_group_member_info on every
// mention. TTL lets renames / card changes eventually propagate; the cap bounds
// memory for long-running processes. 10 min balances RPC savings against staleness.
const GROUP_MEMBER_TTL_MS = 10 * 60_000;
const GROUP_MEMBER_CACHE_MAX = 5_000;
const FRIEND_REMARK_TTL_MS = 10 * 60_000;

export interface OneBotApiClient {
  sendMessage(chatId: string, segments: OneBotMessageSegment[], replyTo?: string): Promise<{ messageId: string }>;
  /** Download a file. For OneBot, `file` is typically a file identifier or URL from a message segment. */
  downloadFile(file: string, chatId: string): Promise<Buffer>;
  /** Get group member info, used for resolving mention info in group messages. */
  getGroupMemberInfo(groupId: string, userId: string): Promise<CanonicalUser>;
  /** Get the current group or private-chat display name. */
  getChatName(chatId: string): Promise<string>;
  /** Get the bot account's friend remark for a user, if present. */
  getFriendRemark(userId: string): Promise<string | undefined>;
  /** Get 20 messages from the specified chat */
  fetchMessages(chatId: string, fromMessageId?: string): Promise<OneBotMessageEvent[]>;
}

interface GroupMemberCacheEntry {
  user: CanonicalUser;
  expiresAtMs: number;
}

export interface GroupMemberCacheOptions {
  ttlMs?: number;
  maxSize?: number;
  now?: () => number;
}

// Result cache for get_group_member_info with three properties the bare
// Record<string, CanonicalUser> lacked: inflight de-dup (concurrent lookups of
// the same key share one RPC), TTL refresh (renames / card changes eventually
// propagate), and a bounded LRU (memory stays flat over long uptimes). Mirrors
// the packTitleCache + packTitleInflight pattern in telegram/manager.ts.
export const createGroupMemberCache = (
  fetcher: (groupId: string, userId: string) => Promise<CanonicalUser>,
  options: GroupMemberCacheOptions = {},
) => {
  const ttlMs = options.ttlMs ?? GROUP_MEMBER_TTL_MS;
  const maxSize = options.maxSize ?? GROUP_MEMBER_CACHE_MAX;
  const now = options.now ?? Date.now;

  const cache = new Map<string, GroupMemberCacheEntry>();
  const inflight = new Map<string, Promise<CanonicalUser>>();

  const touch = (key: string, entry: GroupMemberCacheEntry) => {
    // Map preserves insertion order; delete+set moves the key to the most-recent
    // end so eviction removes the genuinely least-recently-used entry.
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    get: async (groupId: string, userId: string): Promise<CanonicalUser> => {
      const key = `${groupId}:${userId}`;

      const cached = cache.get(key);
      if (cached && cached.expiresAtMs > now()) {
        touch(key, cached);
        return cached.user;
      }

      const existing = inflight.get(key);
      if (existing) return await existing;

      const task = (async () => {
        const user = await fetcher(groupId, userId);
        touch(key, { user, expiresAtMs: now() + ttlMs });
        return user;
      })();

      inflight.set(key, task);
      try {
        return await task;
      } finally {
        // Always drop the inflight entry so a rejected promise is never cached.
        inflight.delete(key);
      }
    },
  };
};

export const createFriendRemarkCache = (
  fetcher: () => Promise<Array<{ user_id: number; remark?: string }>>,
  options: { ttlMs?: number; now?: () => number } = {},
) => {
  const ttlMs = options.ttlMs ?? FRIEND_REMARK_TTL_MS;
  const now = options.now ?? Date.now;
  let remarks = new Map<string, string>();
  let expiresAtMs = 0;
  let inflight: Promise<void> | undefined;

  const refresh = async () => {
    const friends = await fetcher();
    remarks = new Map(friends.flatMap(friend => {
      const remark = friend.remark?.trim();
      return remark ? [[String(friend.user_id), remark] as const] : [];
    }));
    expiresAtMs = now() + ttlMs;
  };

  return {
    get: async (userId: string): Promise<string | undefined> => {
      if (now() >= expiresAtMs) {
        inflight ??= refresh();
        try {
          await inflight;
        } finally {
          inflight = undefined;
        }
      }
      return remarks.get(userId);
    },
  };
};

const createApiClient = (
  ws: WebSocket,
): OneBotApiClient => {
  const pendingCalls = new Map<string, PendingCall>();

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as OneBotApiResponse | OneBotEvent;

      // API responses have an echo field matching the request
      if ('echo' in msg && msg.echo) {
        const pending = pendingCalls.get(msg.echo);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(msg.echo);
          if (msg.status === 'ok') {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(`OneBot API error: retcode=${msg.retcode}`));
          }
        }
        return;
      }

      // Events (with post_type) are handled by the server-level callback
      // This function is only for API calls; events are handled upstream.
    } catch {
      // Not JSON or not a response we're waiting for — ignore
    }
  });

  ws.on('close', () => {
    for (const [, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket connection closed'));
    }
    pendingCalls.clear();
  });

  const call = <T>(action: string, params: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const echo = randomUUID();
      const timer = setTimeout(() => {
        pendingCalls.delete(echo);
        reject(new Error(`OneBot API request "${action}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      pendingCalls.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer });

      const request: OneBotApiRequest = { action, params, echo };
      ws.send(JSON.stringify(request));
    });

  const groupMemberCache = createGroupMemberCache(async (groupId, userId) => {
    const result = await call<{ nickname: string; card?: string; remark?: string }>('get_group_member_info', {
      group_id: parseInt(groupId, 10),
      user_id: parseInt(userId, 10),
    });
    return adaptUser(parseInt(userId, 10), result.nickname, result.card, result.remark);
  });
  const friendRemarkCache = createFriendRemarkCache(() =>
    call<Array<{ user_id: number; remark?: string }>>('get_friend_list', {}));

  return {
    sendMessage: async (chatId, segments, replyTo) => {
      const isGroup = !chatId.startsWith('private:');
      const msg: OneBotMessageSegment[] = [];
      if (replyTo) msg.push({ type: 'reply', data: { id: replyTo } });
      msg.push(...segments);

      const result = await call<{ message_id: number }>('send_msg', {
        message_type: isGroup ? 'group' : 'private',
        ...(isGroup ? { group_id: parseInt(chatId, 10) } : { user_id: parseInt(chatId.slice(8), 10) }),
        message: msg,
      });

      return { messageId: String(result.message_id) };
    },

    downloadFile: async (file: string, _chatId: string): Promise<Buffer> => {
      // 对 napcat get_file / get_image 的封装
      if (file.startsWith('base64://'))
        return Buffer.from(file.slice(9), 'base64');

      const imageExts = /\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff)(\?|$)/i;
      const isImage = imageExts.test(file);
      const action = isImage ? 'get_image' : 'get_file';

      // httpGetBuffer routes through src/http.ts so any HttpError thrown here
      // masks registered secrets (e.g. accessToken) that may appear in the URL.
      const downloadFromUrl = (url: string): Promise<Buffer> => httpGetBuffer(url, DOWNLOAD_TIMEOUT_MS);

      const result = await call<OneBotGetFileResult>(action, { file });

      // got file directly as base64
      if (result.base64)
        return Buffer.from(result.base64, 'base64');

      // file field may be base64://... or a local path
      if (result.file) {
        if (result.file.startsWith('base64://'))
          return Buffer.from(result.file.slice(9), 'base64');
        if (result.file.startsWith('http'))
          return await downloadFromUrl(result.file);
        // local path
        if (fs.existsSync(result.file))
          return await fs.promises.readFile(result.file);
      }

      // file url
      if (result.url)
        return await downloadFromUrl(result.url);

      throw new Error(redactSecrets(`Cannot download file: ${action} returned no url for "${file.slice(0, 80)}"`));
    },

    getGroupMemberInfo: (groupId: string, userId: string): Promise<CanonicalUser> =>
      groupMemberCache.get(groupId, userId),

    getChatName: async (chatId: string): Promise<string> => {
      if (chatId.startsWith('private:')) {
        const userId = parseInt(chatId.slice(8), 10);
        const result = await call<{ nickname: string; remark?: string }>('get_stranger_info', { user_id: userId });
        return [result.remark, result.nickname, chatId].find(name => name?.trim()) ?? chatId;
      }
      const result = await call<{ group_name: string }>('get_group_info', {
        group_id: parseInt(chatId, 10),
      });
      return result.group_name.trim() ? result.group_name : chatId;
    },

    getFriendRemark: (userId: string): Promise<string | undefined> =>
      friendRemarkCache.get(userId),

    fetchMessages: async (chatId: string, fromMessageId?: string): Promise<OneBotMessageEvent[]> => {
      const isGroup = !chatId.startsWith('private:');

      if (isGroup) {
        const groupId = parseInt(chatId, 10);
        const result = await call<{ messages: OneBotMessageEvent[] }>('get_group_msg_history', {
          group_id: groupId,
          message_seq: fromMessageId ? parseInt(fromMessageId, 10) : undefined,
        });
        return result.messages;
      } else {
        // not supported
        return [];
      }
    },
  };
};

export interface OneBotServerDeps {
  onEvent: (raw: OneBotMessageEvent | OneBotNoticeEvent, meta: OneBotIngressMeta) => void;
  log: Logger;
}

export interface OneBotServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  address: AddressInfo | string | null;
  api: OneBotApiClient | null;
  selfId: string | null;
}

export const createOneBotServer = (
  config: OneBotConfig,
  deps: OneBotServerDeps,
): OneBotServer => {
  const { log } = deps;

  // Mask the access token in any HttpError raised by the unified http client
  // (download URLs may carry it). Equal-length redaction; safe to call repeatedly.
  if (config.accessToken) registerHttpSecret(config.accessToken);

  let api: OneBotApiClient | null = null;
  let selfId: string | null = null;
  let activeWebSocket: WebSocket | null = null;
  let httpServer: ReturnType<typeof createServer> | null = null;
  let webSocketServer: WebSocketServer | null = null;

  const start = async (): Promise<void> => {
    const server = createServer();

    const wss = new WebSocketServer({ server });
    webSocketServer = wss;

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // Access token validation
      const auth = req.headers['authorization'];
      if (config.accessToken) {
        const expected = `Bearer ${config.accessToken}`;
        if (auth !== expected) {
          log.withFields({ ip: req.socket.remoteAddress }).warn('OneBot WS connection rejected: invalid access token');
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      log.withFields({ ip: req.socket.remoteAddress }).log('OneBot WS client connected');

      // Only keep one active API client (latest connection wins)
      const connectionApi = createApiClient(ws);
      activeWebSocket = ws;
      api = connectionApi;

      const isEvent = (msg: unknown): msg is OneBotEvent =>
        typeof msg === 'object' && msg !== null && 'post_type' in msg;

      ws.on('message', (data: Buffer) => {
        if (activeWebSocket !== ws) return;
        // Capture ingress meta synchronously at the frame entry, before any
        // adaptation or queueing — this is the ordering source of truth.
        const meta = captureOneBotIngressMeta();
        try {
          const msg = JSON.parse(data.toString());

          // API responses are handled by createApiClient
          if ('echo' in msg && msg.echo) return;

          if (!isEvent(msg)) return;

          switch (msg.post_type) {
          case 'message':
          case 'notice':
            // Adaptation (and its network calls) is deferred to the ingress
            // queue's transform phase, so raw events are forwarded with meta.
            deps.onEvent(msg, meta);
            break;
          case 'meta_event':
            if (msg.meta_event_type === 'lifecycle' && msg.sub_type === 'connect')
              selfId = String(msg.self_id);
            break;
          }
        } catch (err) {
          log.withError(err).warn('Failed to parse OneBot message');
        }
      });

      ws.on('close', code => {
        log.withFields({ code }).log('OneBot WS client disconnected');
        if (activeWebSocket === ws) {
          activeWebSocket = null;
          api = null;
        }
      });

      ws.on('error', err => {
        log.withError(err).error('OneBot WS error');
      });
    });

    await new Promise<void>(resolve => {
      server.listen(config.port, config.host, () => {
        log.withFields({ host: config.host, port: config.port }).log('OneBot WS server listening');
        resolve();
      });
    });

    httpServer = server;
  };

  const stop = async (): Promise<void> => {
    const currentHttpServer = httpServer;
    const currentWebSocketServer = webSocketServer;
    httpServer = null;
    webSocketServer = null;
    api = null;
    selfId = null;
    activeWebSocket = null;

    for (const client of currentWebSocketServer?.clients ?? []) client.terminate();

    await Promise.all([
      currentWebSocketServer
        ? new Promise<void>((resolve, reject) => {
          currentWebSocketServer.close(err => err ? reject(err) : resolve());
        })
        : Promise.resolve(),
      currentHttpServer
        ? new Promise<void>((resolve, reject) => {
          currentHttpServer.close(err => err ? reject(err) : resolve());
        })
        : Promise.resolve(),
    ]);
  };

  return {
    start,
    stop,
    get address() { return httpServer?.address() ?? null; },
    get api() { return api; },
    get selfId() { return selfId; },
  };
};
