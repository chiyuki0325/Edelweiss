import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { createImageToTextResolver, prepareImageToTextBuffer } from './image-to-text';

const imageSizeFromBuffer = async (buffer: Buffer) => {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height };
};

describe('prepareImageToTextBuffer', () => {
  it('compresses images by default', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: 'red',
      },
    }).png().toBuffer();

    const size = await imageSizeFromBuffer(await prepareImageToTextBuffer(source));

    expect(size).toEqual({ width: 591, height: 443 });
  });

  it('keeps original dimensions when compression is disabled', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: 'red',
      },
    }).png().toBuffer();

    const size = await imageSizeFromBuffer(await prepareImageToTextBuffer(source, {
      compress: false,
      pixelBudget: 512 * 512,
    }));

    expect(size).toEqual({ width: 800, height: 600 });
  });

  it('uses the configured pixel budget when compression is enabled', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: 'red',
      },
    }).png().toBuffer();

    const size = await imageSizeFromBuffer(await prepareImageToTextBuffer(source, {
      compress: true,
      pixelBudget: 75_000,
    }));

    expect(size).toEqual({ width: 316, height: 237 });
  });
});

describe('createImageToTextResolver conversation seeds', () => {
  it('uses the prompt that actually generated a cached alt text', async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    }).png().toBuffer();
    const start = vi.fn(async () => ({ imageId: 'img_seed', description: 'cached', reused: false }));
    const resolver = createImageToTextResolver({
      enabled: true,
      model: { apiBaseUrl: 'https://example.test', apiKey: 'key', model: 'vision' },
      logger: { withContext() { return this; } } as any,
      lookupByHash: () => ({
        imageHash: 'hash',
        altText: 'cached',
        altTextTokens: 3,
        seedSystemPrompt: 'ACTUAL ORIGINAL PROMPT',
        seedUserText: 'Describe this image.',
      }),
      persist: () => {},
      conversations: { start, ask: vi.fn() } as any,
    });

    const result = await resolver.resolve(source, 'a different current caption', source, {
      compression: { compress: false, pixelBudget: 100 },
      conversation: { chatId: 'chat', messageId: '1', attachmentIndex: 0 },
    });

    expect(result.imageId).toBe('img_seed');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'ACTUAL ORIGINAL PROMPT',
      initialUserText: 'Describe this image.',
      initialResponse: 'cached',
    }));
  });

  it('does not invent a conversation for a legacy cache row without its prompt', async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    }).png().toBuffer();
    const start = vi.fn();
    const resolver = createImageToTextResolver({
      enabled: true,
      model: { apiBaseUrl: 'https://example.test', apiKey: 'key', model: 'vision' },
      logger: { withContext() { return this; } } as any,
      lookupByHash: () => ({ imageHash: 'hash', altText: 'legacy', altTextTokens: 3 }),
      persist: () => {},
      conversations: { start, ask: vi.fn() } as any,
    });

    const result = await resolver.resolve(source, 'caption', source, {
      conversation: { chatId: 'chat', messageId: '1', attachmentIndex: 0 },
    });

    expect(result.imageId).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
