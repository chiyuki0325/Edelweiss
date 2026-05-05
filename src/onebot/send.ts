import { execFile } from 'node:child_process';

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

export const renderTextToSegments = (text: string): OneBotMessageSegment[] => {
  const plain = markdownToPlainText(text);
  if (!plain) return [];
  return [{ type: 'text', data: { text: plain } }];
};

const READ_TIMEOUT_MS = 60_000;

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

interface SendAttachment {
  type: string;
  path: string;
  file_name?: string;
}

/** Build message segments from text + optional attachments. */
export const buildSendMessage = async (
  runtime: RuntimeConfig,
  text: string,
  options?: {
    replyTo?: string;
    attachments?: SendAttachment[];
  },
): Promise<OneBotMessageSegment[]> => {
  const segments: OneBotMessageSegment[] = [];

  if (options?.replyTo)
    segments.push({ type: 'reply', data: { id: options.replyTo } });

  segments.push(...renderTextToSegments(text));

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
        segments.push({ type: 'file', data: { file: dataUri, name: att.file_name } });
        break;
      }
    }
  }

  return segments;
};
