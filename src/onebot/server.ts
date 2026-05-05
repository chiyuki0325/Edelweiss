import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import type { Logger } from '@guiiai/logg';
import { WebSocketServer, type WebSocket } from 'ws';

import { adaptOneBotMessage, adaptOneBotNotice } from './adaptation';
import type {
  OneBotApiRequest,
  OneBotApiResponse,
  OneBotConfig,
  OneBotEvent,
  OneBotMessageSegment,
} from './types';
import type { CanonicalIMEvent } from '../adaptation/types';

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
      // OneBot file references can be:
      // - base64://... (inline base64 data)
      // - http://... or https://... (URL)
      // - An absolute path on the QQ server (for get_image action)
      if (file.startsWith('base64://')) {
        return Buffer.from(file.slice(9), 'base64');
      }

      if (file.startsWith('http://') || file.startsWith('https://')) {
        const resp = await fetch(file, { signal: AbortSignal.timeout(60_000) });
        if (!resp.ok) throw new Error(`Failed to download file: HTTP ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
      }

      // Try get_image action as fallback
      const result = await call<{ file?: string }>('get_image', { file });
      if (result.file) {
        if (result.file.startsWith('base64://'))
          return Buffer.from(result.file.slice(9), 'base64');
        if (result.file.startsWith('http'))
          return Buffer.from(await (await fetch(result.file)).arrayBuffer());
        return Buffer.from(result.file, 'base64');
      }

      throw new Error(`Cannot download file: unsupported file reference "${file.slice(0, 80)}"`);
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
        try {
          const msg = JSON.parse(data.toString());

          // API responses are handled by createApiClient
          if ('echo' in msg && msg.echo) return;

          if (!isEvent(msg)) return;

          switch (msg.post_type) {
          case 'message': {
            const event = adaptOneBotMessage(msg);
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
