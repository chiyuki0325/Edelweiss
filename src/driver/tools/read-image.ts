import sharp from 'sharp';

import type { CahciuaTool } from './types';
import { createTool } from './types';
import type { InputPart } from '../../unified-api/types';

const prepareImage = async (buffer: Buffer, detail: 'low' | 'high'): Promise<Buffer> => {
  const maxEdge = detail === 'high' ? 1024 : 512;
  return await sharp(buffer)
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
};

export const createReadImageTool = (deps: {
  downloadAttachment: (fileId: string) => Promise<Buffer>;
  readFile: (path: string) => Promise<Buffer>;
  resolveImageToText?: (buffer: Buffer, detail: 'low' | 'high') => Promise<string>;
}): CahciuaTool => createTool({
  name: 'read_image',
  execution: {
    lane: 'readonly',
    waitForWriters: input => Boolean((input as { path?: string }).path),
  },
  description: 'Read and analyze an image from a chat attachment or the filesystem.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'The file-id from an attachment element (format: messageId:index).',
      },
      path: {
        type: 'string',
        description: 'Filesystem path to an image file.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'high'],
        description: 'Resolution level. Use "high" to read fine details or text in the image. Default: low.',
      },
    },
  },
  execute: async input => {
    const { file_id, path, detail: rawDetail } = input as { file_id?: string; path?: string; detail?: string };
    const detail: 'low' | 'high' = rawDetail === 'high' ? 'high' : 'low';

    if ((!file_id && !path) || (file_id && path))
      return { content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }), requiresFollowUp: true };

    // 1. Acquire buffer
    let buffer: Buffer;
    try {
      buffer = file_id
        ? await deps.downloadAttachment(file_id)
        : await deps.readFile(path!);
    } catch (err) {
      return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true };
    }

    // 2. Validate image via sharp
    try {
      await sharp(buffer).metadata();
    } catch {
      return { content: JSON.stringify({ error: 'File is not a valid image.' }), requiresFollowUp: true };
    }

    // 3. Prepare image
    const resizedBuffer = await prepareImage(buffer, detail);

    // 4. Return
    if (deps.resolveImageToText) {
      const description = await deps.resolveImageToText(resizedBuffer, detail);
      return { content: JSON.stringify({ ok: true, description }), requiresFollowUp: true };
    }

    return {
      content: [{ kind: 'image', image: sharp(resizedBuffer), detail }] satisfies InputPart[],
      requiresFollowUp: true,
    };
  },
});
