import sharp from 'sharp';

import type { OneBotApiClient } from './server';
import type { CanonicalAttachment } from '../adaptation/types';
import type { ImageToTextResolver } from '../telegram/image-to-text';
import type { AnimationToTextResolver } from '../telegram/animation-to-text';
import { extractFrames } from '../telegram/frame-extractor';

const THUMBNAIL_PIXEL_BUDGET = 75_000; // pixels, ≈100 Claude tokens

const generateThumbnail = async (buffer: Buffer): Promise<Buffer> => {
  const image = sharp(buffer);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('Failed to read image metadata');

  const aspect = meta.width / meta.height;
  const thumbHeight = Math.round(Math.sqrt(THUMBNAIL_PIXEL_BUDGET / aspect));
  const thumbWidth = Math.round(thumbHeight * aspect);

  return await image
    .resize(thumbWidth, thumbHeight, { fit: 'inside' })
    .webp()
    .toBuffer();
};

const imageExts = /\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff)(\?|$)/i;

const FORMAT_TO_MIME = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  svg: 'image/svg+xml'
} as const;

type SupportedFormat = keyof typeof FORMAT_TO_MIME;

export const isImageFileRef = (fileRef: string): boolean =>
  imageExts.test(fileRef) || fileRef.startsWith('base64://') || fileRef.startsWith('http');

/** Download an image from OneBot and generate alt text via the shared image-to-text resolver. */
export const resolveOneBotImageAltText = async (
  att: CanonicalAttachment,
  caption: string,
  api: OneBotApiClient,
  imageResolver: ImageToTextResolver,
  animationResolver: AnimationToTextResolver,
): Promise<void> => {
  if (!['sticker', 'photo', 'animation'].includes(att.type)) return;
  if (!att.fileRef) return;
  if (!isImageFileRef(att.fileRef)) return;

  try {
    // 1. Download the image
    const buffer = await api.downloadFile(att.fileRef, '');

    // 2. Generate thumbnail for cache key + rendering
    const thumbnailBuffer = await generateThumbnail(buffer);
    att.thumbnailWebp = thumbnailBuffer.toString('base64');

    // 3. Resolve via shared resolver (handles cache lookup + LLM)
    try {
      if (att.type === 'animation') {
        // resolve mimetype (consumed by extractFrames)
        const format = await sharp(buffer).metadata().then(meta => meta.format ?? 'unknown');
        let mime = 'application/octet-stream';
        if (format && format in FORMAT_TO_MIME) {
          mime = FORMAT_TO_MIME[format as SupportedFormat];
        }

        const extract = await extractFrames(buffer, { mimeType: mime });
        const record = await animationResolver.resolve({
          cacheKey: extract.cacheKey,
          frames: extract.frames,
          caption,
          isSticker: true, // OneBot doesn't differentiate animated stickers, treat all as stickers for better alt text
          duration: extract.frameTimestamps ? Math.max(...extract.frameTimestamps) : undefined,
          frameTimestamps: extract.frameTimestamps,
        });
        att.altText = record.altText;
        if (record.stickerSetName) att.stickerSetName = record.stickerSetName;

      } else {
        const record = await imageResolver.resolve(thumbnailBuffer, caption, buffer);
        att.altText = record.altText;
        if (record.stickerSetName) att.stickerSetName = record.stickerSetName;
      }
    } catch {
      // LLM failure: leave altText unset, attachment still renders with thumbnail
    }
  } catch {
    // Download or thumbnail failure: leave attachment as-is
  }
};
