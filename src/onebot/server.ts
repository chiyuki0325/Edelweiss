import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import type { Logger } from '@guiiai/logg';
import { WebSocketServer, type WebSocket } from 'ws';

import { adaptOneBotMessage, adaptOneBotNotice, adaptUser } from './adaptation';
import type {
  OneBotApiRequest,
  OneBotApiResponse,
  OneBotConfig,
  OneBotEvent,
  OneBotGetFileResult,
  OneBotMessageEvent,
  OneBotMessageSegment,
} from './types';
import type { CanonicalIMEvent, CanonicalUser } from '../adaptation/types';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface OneBotApiClient {
  sendMessage(chatId: string, segments: OneBotMessageSegment[], replyTo?: string): Promise<{ messageId: string }>;
  /** Download a file. For OneBot, `file` is typically a file identifier or URL from a message segment. */
  downloadFile(file: string, chatId: string): Promise<Buffer>;
  /** Get group member info, used for resolving mention info in group messages. */
  getGroupMemberInfo(groupId: string, userId: string): Promise<CanonicalUser>;
  /** Get 20 messages from the specified chat */
  fetchMessages(chatId: string, fromMessageId?: string): Promise<OneBotMessageEvent[]>;
}

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

  const resolvedGroupMember: Record<string, CanonicalUser> = {};

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

      const downloadFromUrl = async (url: string): Promise<Buffer> => {
        const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
      };

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

      throw new Error(`Cannot download file: ${action} returned no url for "${file.slice(0, 80)}"`);
    },

    getGroupMemberInfo: async (groupId: string, userId: string): Promise<CanonicalUser> => {
      const key = `${groupId}:${userId}`;
      if (resolvedGroupMember[key]) return resolvedGroupMember[key];

      const result = await call<{ nickname: string; card: string }>('get_group_member_info', {
        group_id: parseInt(groupId, 10),
        user_id: parseInt(userId, 10),
      });

      const user = adaptUser(parseInt(userId, 10), result.nickname, result.card);
      resolvedGroupMember[key] = user;
      return user;
    },

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
  onEvent: (chatId: string, event: CanonicalIMEvent) => void;
  log: Logger;
}

export interface OneBotServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  api: OneBotApiClient | null;
  selfId: string | null;
}

export const createOneBotServer = (
  config: OneBotConfig,
  deps: OneBotServerDeps,
): OneBotServer => {
  const { log } = deps;

  let api: OneBotApiClient | null = null;
  let selfId: string | null = null;
  let httpServer: ReturnType<typeof createServer> | null = null;

  const start = async (): Promise<void> => {
    const server = createServer();

    const wss = new WebSocketServer({ server });

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
      api = createApiClient(ws);

      const isEvent = (msg: unknown): msg is OneBotEvent =>
        typeof msg === 'object' && msg !== null && 'post_type' in msg;

      ws.on('message', (data: Buffer) => {
        void (async () => {
          try {
            const msg = JSON.parse(data.toString());

            // API responses are handled by createApiClient
            if ('echo' in msg && msg.echo) return;

            if (!isEvent(msg)) return;

            switch (msg.post_type) {
            case 'message': {
              const event = await adaptOneBotMessage(api!!, msg);  // 必须连上了才会有消息被上报，所以这里直接断言 api 不为 null
              deps.onEvent(event.chatId, event);
              break;
            }
            case 'notice': {
              const event = adaptOneBotNotice(msg);
              if (event) deps.onEvent(event.chatId, event);
              break;
            }
            case 'meta_event':
              if (msg.meta_event_type === 'lifecycle' && msg.sub_type === 'connect')
                selfId = String(msg.self_id);
              break;
            }
          } catch (err) {
            log.withError(err).warn('Failed to parse OneBot message');
          }
        })();
      });

      ws.on('close', code => {
        log.withFields({ code }).log('OneBot WS client disconnected');
        api = null;
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
    if (httpServer) {
      await new Promise<void>(resolve => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }
  };

  return { start, stop, get api() { return api; }, get selfId() { return selfId; } };
};
