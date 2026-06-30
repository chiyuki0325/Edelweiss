import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { prepareImageToTextBuffer } from './image-to-text';

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
