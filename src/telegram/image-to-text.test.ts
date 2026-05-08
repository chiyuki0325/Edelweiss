import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { prepareImageToTextUrl } from './image-to-text';

const imageSizeFromDataUrl = async (url: string) => {
  const base64 = url.replace(/^data:image\/png;base64,/, '');
  const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
  return { width: meta.width, height: meta.height };
};

describe('prepareImageToTextUrl', () => {
  it('compresses images by default', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: 'red',
      },
    }).png().toBuffer();

    const size = await imageSizeFromDataUrl(await prepareImageToTextUrl(source));

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

    const size = await imageSizeFromDataUrl(await prepareImageToTextUrl(source, {
      compress: false,
      pixelBudget: 512 * 512,
    }));

    expect(size).toEqual({ width: 800, height: 600 });
  });

  it('compresses stickers even when compression is disabled', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: 'red',
      },
    }).png().toBuffer();

    const size = await imageSizeFromDataUrl(await prepareImageToTextUrl(source, {
      compress: false,
      pixelBudget: 512 * 512,
    }, { isSticker: true }));

    expect(size).toEqual({ width: 591, height: 443 });
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

    const size = await imageSizeFromDataUrl(await prepareImageToTextUrl(source, {
      compress: true,
      pixelBudget: 75_000,
    }));

    expect(size).toEqual({ width: 316, height: 237 });
  });
});
