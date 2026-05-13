import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { renderImageToTextSystemPrompt } from './image-to-text-prompt';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { CanonicalAttachment } from '../adaptation/types';
import type { LlmEndpoint } from '../driver/types';

export interface ImageToTextCompressionConfig {
  compress: boolean;
  pixelBudget: number;
}

export interface ImageToTextResolveOptions {
  isSticker?: boolean;
}

const DEFAULT_IMAGE_TO_TEXT_COMPRESSION: ImageToTextCompressionConfig = {
  compress: true,
  pixelBudget: 512 * 512,
};

const maxEdgeForPixelBudget = (buffer: Buffer, pixelBudget: number): Promise<number> =>
  sharp(buffer).metadata().then(meta => {
    const w = meta.width ?? Math.floor(Math.sqrt(pixelBudget));
    const h = meta.height ?? Math.floor(Math.sqrt(pixelBudget));
    const longEdge = Math.max(w, h);
    const shortEdge = Math.max(Math.min(w, h), 1);
    return Math.floor(Math.sqrt(pixelBudget * (longEdge / shortEdge)));
  });

export const prepareImageToTextUrl = async (
  buffer: Buffer,
  compression: ImageToTextCompressionConfig = DEFAULT_IMAGE_TO_TEXT_COMPRESSION,
  options: ImageToTextResolveOptions = {},
): Promise<string> => {
  const image = sharp(buffer);
  const shouldCompress = options.isSticker === false || compression.compress;
  const maxEdge = shouldCompress ? await maxEdgeForPixelBudget(buffer, compression.pixelBudget) : undefined;
  const prepared = maxEdge
    ? image.resize(maxEdge, maxEdge, {
        fit: 'inside',
        withoutEnlargement: true,
      })
    : image;
  const png = await prepared.png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
};

export interface ImageAltTextRecord {
  imageHash: string;
  altText: string;
  altTextTokens: number;
  stickerSetName?: string;
}

export interface ImageToTextResolver {
  resolve(thumbnailBuffer: Buffer, caption: string, highResBuffer?: Buffer, options?: ImageToTextResolveOptions): Promise<ImageAltTextRecord>;
  hydrateCanonicalAttachments(attachments: CanonicalAttachment[], caption: string): Promise<void>;
}

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Compute cache key from a base64-encoded thumbnail. */
export const computeThumbnailHash = (thumbnailWebp: string): string =>
  hashBuffer(Buffer.from(thumbnailWebp, 'base64'));

export const createImageToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  compression?: ImageToTextCompressionConfig;
  semaphore?: ReturnType<typeof createSemaphore>;
  logger: Logger;
  lookupByHash: (imageHash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}): ImageToTextResolver => {
  const log = params.logger.withContext('image-to-text');
  const semaphore = params.semaphore ?? createSemaphore(3);
  const compression = params.compression ?? DEFAULT_IMAGE_TO_TEXT_COMPRESSION;
  const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>();

  // Core: thumbnail hash → dedup → cache lookup → semaphore-gated LLM → persist
  const resolveByBuffer = (
    thumbnailBuffer: Buffer,
    caption: string,
    highResBuffer?: Buffer,
    options: ImageToTextResolveOptions = {},
  ): Promise<ImageAltTextRecord> => {
    const imageHash = hashBuffer(thumbnailBuffer);

    const existing = inflightByHash.get(imageHash);
    if (existing) return existing;

    const task = (async (): Promise<ImageAltTextRecord> => {
      const cached = params.lookupByHash(imageHash);
      if (cached) return cached;

      await semaphore.acquire();
      try {
        // Re-check after acquiring semaphore
        const recheck = params.lookupByHash(imageHash);
        if (recheck) return recheck;

        const model = params.model;
        if (!model) throw new Error('imageToText.model is required when imageToText.enabled=true');

        const imageUrl = await prepareImageToTextUrl(highResBuffer ?? thumbnailBuffer, compression, options);
        const system = await renderImageToTextSystemPrompt({ caption });

        const result = await callDescriptionLlm({
          model,
          system,
          userText: 'Describe this image.',
          images: [{ url: imageUrl }],
          log,
          label: 'image-to-text',
        });
        const altText = result.text.trim();
        if (!altText) throw new Error('Image-to-text model returned empty alt text');

        const record: ImageAltTextRecord = {
          imageHash,
          altText,
          altTextTokens: result.outputTokens,
        };
        params.persist(record);
        return record;
      } finally {
        semaphore.release();
      }
    })();

    inflightByHash.set(imageHash, task);
    void task.finally(() => inflightByHash.delete(imageHash));
    return task;
  };

  return {
    resolve(thumbnailBuffer, caption, highResBuffer, options) {
      return resolveByBuffer(thumbnailBuffer, caption, highResBuffer, options);
    },

    async hydrateCanonicalAttachments(attachments, caption) {
      if (!params.enabled) return;
      await Promise.all(attachments.map(async att => {
        if (att.altText || !att.thumbnailWebp) return;
        const buffer = Buffer.from(att.thumbnailWebp, 'base64');
        const record = await resolveByBuffer(buffer, caption);
        att.altText = record.altText;
      }));
    },
  };
};
