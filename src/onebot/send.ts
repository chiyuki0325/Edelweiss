import { execFile } from 'node:child_process';
import { mkdtemp, readFile as readNodeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@guiiai/logg';

import type { OneBotMessageSegment } from './types';
import type { RuntimeConfig } from '../config/config';

/** Convert LLM markdown output to plain text suitable for QQ. */
const markdownToPlainText = (text: string): string =>
  text
    // Bold/italic markers
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Links [text](url)
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    // Code blocks
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/`(.+?)`/g, '$1')
    // Headers
    .replace(/^#{1,6}\s+/gm, '')
    // Strikethrough
    .replace(/~~(.+?)~~/g, '$1')
    .trim();

type MarkdownTextPart = {
  kind: 'text';
  text: string;
};

type MarkdownCodePart = {
  kind: 'code';
  code: string;
  language?: string;
  raw: string;
};

type MarkdownPart = MarkdownTextPart | MarkdownCodePart;

export type CodeBlockRenderer = (code: string, language?: string) => Promise<Buffer>;

interface RenderTextOptions {
  renderCodeBlock?: CodeBlockRenderer;
  logger?: Logger;
}

const FENCED_CODE_RE = /^[ \t]*(`{3,}|~{3,})([^\n]*)\r?\n([\s\S]*?)^[ \t]*\1[ \t]*(?:\r?\n|$)/gm;

const splitMarkdownParts = (text: string): MarkdownPart[] => {
  const parts: MarkdownPart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = FENCED_CODE_RE.exec(text)) !== null) {
    if (match.index > cursor)
      parts.push({ kind: 'text', text: text.slice(cursor, match.index) });

    const info = match[2]!.trim();
    const language = info ? info.split(/\s+/)[0] : undefined;
    parts.push({
      kind: 'code',
      code: match[3]!.replace(/\r\n/g, '\n').replace(/\n$/, ''),
      language,
      raw: match[0]!.trim(),
    });
    cursor = match.index + match[0]!.length;
  }

  if (cursor < text.length)
    parts.push({ kind: 'text', text: text.slice(cursor) });

  return parts;
};

const pushTextSegment = (segments: OneBotMessageSegment[], text: string) => {
  const plain = markdownToPlainText(text);
  if (plain) segments.push({ type: 'text', data: { text: plain } });
};

const READ_TIMEOUT_MS = 60_000;
const SILICON_TIMEOUT_MS = 30_000;
const SILICON_MAX_BUFFER = 1024 * 1024;

const readFile = (runtime: RuntimeConfig, path: string): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const cmd = runtime.readFile;
    const child = execFile(
      cmd[0]!,
      [...cmd.slice(1), path],
      { timeout: READ_TIMEOUT_MS, maxBuffer: runtime.readFileSizeLimit + 1024, encoding: 'buffer' as BufferEncoding },
      (error, stdout) => {
        if (error) return reject(new Error(`readFile failed: ${error.message}`));
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (buf.length > runtime.readFileSizeLimit)
          return reject(new Error(`File too large: ${buf.length} bytes exceeds limit of ${runtime.readFileSizeLimit}`));
        resolve(buf);
      },
    );
    child.stdin?.end();
  });

const toBase64DataUri = (buffer: Buffer): string =>
  `base64://${buffer.toString('base64')}`;

const execSilicon = (args: string[], input: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = execFile(
      'silicon',
      args,
      { timeout: SILICON_TIMEOUT_MS, maxBuffer: SILICON_MAX_BUFFER },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = typeof stderr === 'string' && stderr.trim()
            ? `${error.message}: ${stderr.trim()}`
            : error.message;
          reject(new Error(`silicon failed: ${detail}`));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(input);
  });

export const renderCodeBlockWithSilicon: CodeBlockRenderer = async (code, language) => {
  const dir = await mkdtemp(join(tmpdir(), 'cahciua-silicon-'));
  const output = join(dir, 'code.png');
  try {
    const args = [
      '--output', output,
      '--background', '#ffffff',
      '--pad-horiz', '4',
      '--pad-vert', '4',
    ];
    if (language)
      args.push('--language', language);

    await execSilicon(args, code);
    return await readNodeFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const warnCodeBlockRenderFailure = (logger: Logger | undefined, error: unknown) => {
  if (!logger) return;
  logger.withError(error).warn('Failed to render OneBot code block with silicon; falling back to plain text');
};

export const renderTextToSegments = async (
  text: string,
  options?: RenderTextOptions,
): Promise<OneBotMessageSegment[]> => {
  const segments: OneBotMessageSegment[] = [];
  const renderCodeBlock = options?.renderCodeBlock ?? renderCodeBlockWithSilicon;

  for (const part of splitMarkdownParts(text)) {
    if (part.kind === 'text') {
      pushTextSegment(segments, part.text);
      continue;
    }

    try {
      const image = await renderCodeBlock(part.code, part.language);
      if (image.length > 0) {
        segments.push({ type: 'image', data: { file: toBase64DataUri(image) } });
        continue;
      }
      warnCodeBlockRenderFailure(options?.logger, new Error('silicon produced an empty image'));
    } catch (error) {
      warnCodeBlockRenderFailure(options?.logger, error);
    }
    if (part.raw)
      segments.push({ type: 'text', data: { text: part.raw } });
  }

  return segments;
};

interface SendAttachment {
  type: string;
  path: string;
  file_name?: string;
}

interface BuildSendMessageOptions extends RenderTextOptions {
  replyTo?: string;
  attachments?: SendAttachment[];
}

/** Build message segments from text + optional attachments. */
export const buildSendMessage = async (
  runtime: RuntimeConfig,
  text: string,
  options?: BuildSendMessageOptions,
): Promise<OneBotMessageSegment[]> => {
  const segments: OneBotMessageSegment[] = [];

  if (options?.replyTo)
    segments.push({ type: 'reply', data: { id: options.replyTo } });

  segments.push(...await renderTextToSegments(text, {
    renderCodeBlock: options?.renderCodeBlock,
    logger: options?.logger,
  }));

  if (options?.attachments && options.attachments.length > 0) {
    for (const att of options.attachments) {
      const buffer = await readFile(runtime, att.path);
      const dataUri = toBase64DataUri(buffer);

      switch (att.type) {
      case 'photo':
      case 'animation':
        segments.push({ type: 'image', data: { file: dataUri } });
        break;
      case 'video':
      case 'video_note':
        segments.push({ type: 'video', data: { file: dataUri } });
        break;
      case 'audio':
      case 'voice':
        segments.push({ type: 'record', data: { file: dataUri } });
        break;
      case 'document':
      default:
        // TODO: 需要进一步调试
        segments.push({ type: 'file', data: { file_id: dataUri, file: att.file_name ?? att.path } });
        break;
      }
    }
  }

  return segments;
};
