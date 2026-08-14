import sharp from 'sharp';

import type { CahciuaTool } from './types';
import { createTool } from './types';

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
  resolveImageToText?: (
    buffer: Buffer,
    detail: 'low' | 'high',
    sourceKey: string,
  ) => Promise<{ description: string; imageId: string; reused: boolean }>;
}): CahciuaTool => createTool({
  name: 'read_image',
  execution: {
    lane: 'readonly',
    waitForWriters: input => Boolean((input as { path?: string }).path),
  },
  description: 'Read and analyze an image from a chat attachment, an Instant View telegram:// photo URL, or the filesystem.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'A file-id from an attachment element (messageId:index) or a telegram:// Instant View photo URL.',
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
      try {
        const result = await deps.resolveImageToText(
          resizedBuffer,
          detail,
          file_id ? `file_id:${file_id}` : `path:${path!}`,
        );
        return {
          content: JSON.stringify({
            ok: true,
            description: result.description,
            image_id: result.imageId,
            reused: result.reused,
          }),
          requiresFollowUp: true,
        };
      } catch (err) {
        return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true };
      }
    }

    return {
      content: JSON.stringify({ error: 'read_image requires an imageToText.model because the primary model is not multimodal.' }),
      requiresFollowUp: true,
    };
  },
});
