import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';
import type { Message } from 'xsai';

import { renderImageToTextSystemPrompt } from './image-to-text-prompt';
import { streamingChat } from '../driver/streaming';
import { streamingResponses } from '../driver/streaming-responses';
import type { LlmEndpoint } from '../driver/types';
import type { CanonicalAttachment } from '../adaptation/types';

const IMAGE_TO_TEXT_MAX_EDGE = 512;

export interface ImageAltTextRecord {
  imageHash: string;
  altText: string;
  altTextTokens: number;
}

export interface ImageToTextResolver {
  /** Generate + persist alt text. thumbnailBuffer used as cache key; highResBuffer (if provided) used for LLM input. */
  resolve(thumbnailBuffer: Buffer, caption: string, highResBuffer?: Buffer): Promise<ImageAltTextRecord>;
  /** Hydrate altText on canonical attachments from cache/LLM (for cold-start replay). */
  hydrateCanonicalAttachments(attachments: CanonicalAttachment[], caption: string): Promise<void>;
}

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Compute cache key from a base64-encoded thumbnail. */
export const computeThumbnailHash = (thumbnailWebp: string): string =>
  hashBuffer(Buffer.from(thumbnailWebp, 'base64'));

const prepareImageToTextUrl = async (buffer: Buffer): Promise<string> => {
  const resized = await sharp(buffer)
    .resize(IMAGE_TO_TEXT_MAX_EDGE, IMAGE_TO_TEXT_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString('base64')}`;
};

const extractChatText = (message?: { content?: string | { text?: string }[] | null }): string => {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .map(part => part.text ?? '')
    .join('')
    .trim();
};

const extractResponsesText = (output: Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>): string =>
  output
    .filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? [])
    .map(block => block.type === 'output_text' ? (block.text ?? '') : (block.refusal ?? ''))
    .join('')
    .trim();

const createSemaphore = (max: number) => {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (current < max) { current++; resolve(); }
      else queue.push(resolve);
    }),
    release: () => {
      current--;
      const next = queue.shift();
      if (next) { current++; next(); }
    },
  };
};

export const createImageToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency?: number;
  logger: Logger;
  lookupByHash: (imageHash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}): ImageToTextResolver => {
  const log = params.logger.withContext('telegram:image-to-text');
  const semaphore = createSemaphore(params.maxConcurrency ?? 3);
  const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>();

  const callLlm = async (system: string, imageUrl: string): Promise<{ text: string; outputTokens: number }> => {
    const model = params.model;
    if (!model) throw new Error('imageToText.model is required when imageToText.enabled=true');

    log.withFields({ systemLen: system.length, imageUrlLen: imageUrl.length, apiFormat: model.apiFormat ?? 'openai-chat' }).log('image-to-text request');

    if ((model.apiFormat ?? 'openai-chat') === 'responses') {
      const input = [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image.' },
          { type: 'input_image', image_url: imageUrl, detail: 'high' },
        ],
      }];
      const response = await streamingResponses({
        baseURL: model.apiBaseUrl,
        apiKey: model.apiKey,
        model: model.model,
        instructions: system,
        input,
        log,
        label: 'image-to-text',
        timeoutSec: model.timeoutSec,
      });

      return {
        text: extractResponsesText(response.output as Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>),
        outputTokens: response.usage.output_tokens,
      };
    }

    const chatMessages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
      ],
    } as Message];
    const response = await streamingChat({
      baseURL: model.apiBaseUrl,
      apiKey: model.apiKey,
      model: model.model,
      system,
      messages: chatMessages,
      log,
      label: 'image-to-text',
      timeoutSec: model.timeoutSec,
    });

    return {
      text: extractChatText(response.choices[0]?.message),
      outputTokens: response.usage.completion_tokens,
    };
  };

  // Core: thumbnail hash → dedup → cache lookup → semaphore-gated LLM → persist
  const resolveByBuffer = (
    thumbnailBuffer: Buffer,
    caption: string,
    highResBuffer?: Buffer,
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

        const imageUrl = await prepareImageToTextUrl(highResBuffer ?? thumbnailBuffer);
        const system = await renderImageToTextSystemPrompt({ caption });

        const result = await callLlm(system, imageUrl);
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
    task.finally(() => inflightByHash.delete(imageHash));
    return task;
  };

  return {
    resolve(thumbnailBuffer, caption, highResBuffer) {
      return resolveByBuffer(thumbnailBuffer, caption, highResBuffer);
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
