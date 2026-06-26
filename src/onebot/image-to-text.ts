import sharp from 'sharp';

import type { OneBotApiClient } from './server';
import type { CanonicalAttachment } from '../adaption-types';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import { extractFrames } from '../media/frame-extractor';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import { generateThumbnail } from '../media/thumbnail';

const imageExts = /\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff)(\?|$)/i;

const FORMAT_TO_MIME = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
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
  compression?: ImageToTextCompressionConfig,
): Promise<void> => {
  if (!['sticker', 'photo', 'animation'].includes(att.type)) return;
  if (!att.fileRef) return;
  if (!isImageFileRef(att.fileRef)) return;

  // Fail-closed (CLAUDE.md §Consistency Above Availability): any download / LLM
  // failure throws so the OneBot ingress queue's bounded-retry policy governs
  // the outcome. We never degrade to thumbnail-only / empty alt text here.
  // 1. Download the image
  const buffer = await api.downloadFile(att.fileRef, '');

  // 2. Generate thumbnail for cache key + rendering
  att.thumbnailWebp = await generateThumbnail(buffer);

  // 3. Resolve via shared resolver (handles cache lookup + LLM)
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
    const record = await imageResolver.resolve(Buffer.from(att.thumbnailWebp, 'base64'), caption, buffer, { isSticker: att.type === 'sticker', compression });
    att.altText = record.altText;
    if (record.stickerSetName) att.stickerSetName = record.stickerSetName;
  }
};
