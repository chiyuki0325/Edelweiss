import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import type { ImageConversationManager } from './image-conversation';
import { renderImageToTextSystemPrompt } from './image-to-text-prompt';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { CanonicalAttachment } from '../adaption-types';
import type { LlmEndpoint } from '../llm/types';

export interface ImageToTextCompressionConfig {
  compress: boolean;
  pixelBudget: number;
}

export interface ImageToTextResolveOptions {
  isSticker?: boolean;
  compression?: ImageToTextCompressionConfig;
  conversation?: {
    chatId: string;
    messageId: string;
    attachmentIndex: number;
  };
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

export const prepareImageToTextBuffer = async (
  buffer: Buffer,
  compression: ImageToTextCompressionConfig = DEFAULT_IMAGE_TO_TEXT_COMPRESSION,
  options: ImageToTextResolveOptions = {},
): Promise<Buffer> => {
  const image = sharp(buffer);
  const shouldCompress = options.isSticker === false || compression.compress;
  const maxEdge = shouldCompress ? await maxEdgeForPixelBudget(buffer, compression.pixelBudget) : undefined;
  const prepared = maxEdge
    ? image.resize(maxEdge, maxEdge, {
        fit: 'inside',
        withoutEnlargement: true,
      })
    : image;
  return await prepared
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
};

export interface ImageAltTextRecord {
  imageHash: string;
  altText: string;
  altTextTokens: number;
  stickerSetName?: string;
  seedSystemPrompt?: string;
  seedUserText?: string;
}

export interface ImageToTextResolveResult extends ImageAltTextRecord {
  imageId?: string;
}

export interface ImageToTextResolver {
  resolve(thumbnailBuffer: Buffer, caption: string, highResBuffer?: Buffer, options?: ImageToTextResolveOptions): Promise<ImageToTextResolveResult>;
  hydrateCanonicalAttachments(
    attachments: CanonicalAttachment[],
    caption: string,
    compression?: ImageToTextCompressionConfig,
    conversation?: { chatId: string; messageId: string },
  ): Promise<void>;
}

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Compute cache key from a base64-encoded thumbnail. */
export const computeThumbnailHash = (thumbnailWebp: string): string =>
  hashBuffer(Buffer.from(thumbnailWebp, 'base64'));

export const createImageToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  semaphore?: ReturnType<typeof createSemaphore>;
  logger: Logger;
  lookupByHash: (imageHash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
  conversations: ImageConversationManager;
}): ImageToTextResolver => {
  const log = params.logger.withContext('image-to-text');
  const semaphore = params.semaphore ?? createSemaphore(3);
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

        const imageBuffer = await prepareImageToTextBuffer(highResBuffer ?? thumbnailBuffer, options.compression ?? DEFAULT_IMAGE_TO_TEXT_COMPRESSION, options);
        const system = await renderImageToTextSystemPrompt({ caption });
        const userText = 'Describe this image.';

        const result = await callDescriptionLlm({
          model,
          system,
          userText,
          images: [imageBuffer],
          log,
          label: 'image-to-text',
        });
        const altText = result.text.trim();
        if (!altText) throw new Error('Image-to-text model returned empty alt text');

        const record: ImageAltTextRecord = {
          imageHash,
          altText,
          altTextTokens: result.outputTokens,
          seedSystemPrompt: system,
          seedUserText: userText,
        };
        params.persist(record);
        return record;
      } finally {
        semaphore.release();
      }
    })();

    inflightByHash.set(imageHash, task);
    void task.finally(() => inflightByHash.delete(imageHash)).catch(() => {});
    return task;
  };

  const resolve = async (
    thumbnailBuffer: Buffer,
    caption: string,
    highResBuffer?: Buffer,
    options: ImageToTextResolveOptions = {},
  ): Promise<ImageToTextResolveResult> => {
    const record = await resolveByBuffer(thumbnailBuffer, caption, highResBuffer, options);
    const scope = options.conversation;
    if (!scope || !record.seedSystemPrompt || !record.seedUserText) return record;

    const preparedImage = await prepareImageToTextBuffer(
      highResBuffer ?? thumbnailBuffer,
      options.compression ?? DEFAULT_IMAGE_TO_TEXT_COMPRESSION,
      options,
    );
    const model = params.model;
    if (!model) return record;
    const session = await params.conversations.start({
      chatId: scope.chatId,
      sourceKey: `auto:${scope.messageId}:${scope.attachmentIndex}`,
      imageHash: hashBuffer(thumbnailBuffer),
      preparedImage,
      systemPrompt: record.seedSystemPrompt,
      initialUserText: record.seedUserText,
      initialResponse: record.altText,
      initialOutputTokens: record.altTextTokens,
      model,
      label: 'image-to-text',
    });
    return { ...record, imageId: session.imageId };
  };

  return {
    resolve,

    async hydrateCanonicalAttachments(attachments, caption, compression, conversation) {
      if (!params.enabled) return;
      await Promise.all(attachments.map(async (att, attachmentIndex) => {
        if (att.altText || att.imageId || !att.thumbnailWebp || att.animationHash) return;
        const buffer = Buffer.from(att.thumbnailWebp, 'base64');
        const record = await resolve(buffer, caption, undefined, {
          compression,
          ...(conversation ? { conversation: { ...conversation, attachmentIndex } } : {}),
        });
        att.altText = record.altText;
        if (record.imageId) att.imageId = record.imageId;
      }));
    },
  };
};
