/**
 * Local reverse proxy for api.deepseek.com.
 *
 * Usage:
 *   tsx scripts/proxy.ts [PORT]   (default port: 4000)
 *
 * Then point apiBaseUrl in config.yaml to http://localhost:4000
 *
 * For each LLM call, prints a JSON summary line with:
 *   - bodyPrefixRatio  actual byte-level prefix ratio of the full HTTP body vs previous call
 *   - apiCacheHitRate  prompt_cache_hit_tokens / (hit + miss) from DeepSeek usage
 *
 * Request bodies are dumped to /tmp/cahciua-proxy/req-<N>.json for diffing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

const UPSTREAM_HOST = 'api.deepseek.com';
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4000);
const DUMP_DIR = '/tmp/cahciua-proxy';
const CACHE_ALERT_THRESHOLD = 0.8;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN ?? '';
const TG_CHAT_ID = process.env.TG_CHAT_ID ?? '';

mkdirSync(DUMP_DIR, { recursive: true });

if (!TG_BOT_TOKEN || !TG_CHAT_ID)
  console.warn('TG_BOT_TOKEN or TG_CHAT_ID not set — cache alerts disabled');

const sendTelegramAlert = (text: string): void => {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
  const req = httpsRequest({
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TG_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { res.resume(); });
  req.on('error', err => console.error('telegram alert error', err.message));
  req.write(body);
  req.end();
};

let reqCount = 0;

// Keyed by "<method> <path> :: <model>" so different endpoints are tracked separately.
const lastBodyByKey = new Map<string, string>();

// O(min(prev,curr)) early-exit prefix scan on raw body bytes.
const bodyPrefixRatio = (prev: string, curr: string): number => {
  if (curr.length === 0) return 1;
  let i = 0;
  const min = Math.min(prev.length, curr.length);
  while (i < min && prev[i] === curr[i]) i++;
  return i / curr.length;
};

// Extract the last usage object from an SSE stream.
// DeepSeek sends usage in the final data chunk before [DONE]
// when stream_options.include_usage is true.
const extractUsageFromSSE = (text: string): Record<string, number> | null => {
  let usage: Record<string, number> | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as { usage?: Record<string, number> };
      if (chunk.usage && Object.keys(chunk.usage).length > 0)
        usage = chunk.usage;
    } catch { /* malformed chunk, skip */ }
  }
  return usage;
};

// Hop-by-hop headers that must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'accept-encoding',
]);

const forwardHeaders = (headers: IncomingMessage['headers'], bodyLength: number): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined)
      out[k] = v;
  }
  out['host'] = UPSTREAM_HOST;
  out['content-length'] = String(bodyLength);
  return out;
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const bodyChunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('error', err => console.error('client error', err.message));

  req.on('end', () => {
    const bodyBuf = Buffer.concat(bodyChunks);
    const bodyStr = bodyBuf.toString('utf-8');
    const n = ++reqCount;

    // Parse to extract model for the key and log summary.
    let parsed: { model?: string; messages?: unknown[]; stream?: boolean } = {};
    try { parsed = JSON.parse(bodyStr); } catch { /* non-JSON body, leave parsed empty */ }

    const key = `${req.method} ${req.url} :: ${parsed.model ?? 'unknown'}`;
    const prev = lastBodyByKey.get(key);
    const prefixRatio = prev != null ? bodyPrefixRatio(prev, bodyStr) : null;
    lastBodyByKey.set(key, bodyStr);

    writeFileSync(join(DUMP_DIR, `req-${n}.json`), bodyStr);

    const upstreamReq = httpsRequest(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: forwardHeaders(req.headers, bodyBuf.length),
      },
      (proxyRes: IncomingMessage) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

        const resChunks: Buffer[] = [];

        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
          resChunks.push(chunk);
        });

        proxyRes.on('end', () => {
          res.end();
          const resStr = Buffer.concat(resChunks).toString('utf-8');

          // Try SSE usage first, fall back to plain JSON body.
          let usage = extractUsageFromSSE(resStr);
          if (!usage) {
            try {
              const body = JSON.parse(resStr) as { usage?: Record<string, number> };
              if (body.usage) usage = body.usage;
            } catch { /* not JSON */ }
          }

          const hitTokens = usage?.prompt_cache_hit_tokens ?? 0;
          const missTokens = usage?.prompt_cache_miss_tokens ?? 0;
          const cacheTotal = hitTokens + missTokens;
          const apiCacheHitRate = cacheTotal > 0 ? hitTokens / cacheTotal : null;

          if (prefixRatio != null && prefixRatio < CACHE_ALERT_THRESHOLD) {
            sendTelegramAlert(
              '⚠️ <b>KV cache prefix drop</b> @FlowingSnow\n'
              + `req #${n} · model: ${parsed.model ?? 'unknown'}\n`
              + `body prefix ratio: ${(prefixRatio * 100).toFixed(1)}% (threshold ${CACHE_ALERT_THRESHOLD * 100}%)\n`
              + `api cache hit rate: ${apiCacheHitRate != null ? `${(apiCacheHitRate * 100).toFixed(1)}%` : 'N/A'}`,
            );
          }

          const summary: Record<string, unknown> = {
            req: n,
            model: parsed.model,
            path: req.url,
            msgCount: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
            bodyLen: bodyStr.length,
            bodyPrefixRatio: prefixRatio != null ? prefixRatio.toFixed(4) : 'first',
            promptTokens: usage?.prompt_tokens,
            cacheHitTokens: hitTokens,
            cacheMissTokens: missTokens,
            apiCacheHitRate: apiCacheHitRate != null ? apiCacheHitRate.toFixed(4) : 'N/A',
          };

          console.log(JSON.stringify(summary));
        });

        proxyRes.on('error', err => console.error('upstream response error', err.message));
      },
    );

    upstreamReq.on('error', err => {
      console.error('upstream request error', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });

    upstreamReq.write(bodyBuf);
    upstreamReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`proxy  http://localhost:${PORT}  →  https://${UPSTREAM_HOST}`);
  console.log(`dumps  ${DUMP_DIR}/req-<N>.json`);
});
