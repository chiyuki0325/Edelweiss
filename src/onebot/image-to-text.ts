import sharp from 'sharp';

import type { OneBotApiClient } from './server';
import type { CanonicalAttachment } from '../adaptation/types';
import type { ImageToTextResolver } from '../telegram/image-to-text';

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

export const isImageFileRef = (fileRef: string): boolean =>
  imageExts.test(fileRef) || fileRef.startsWith('base64://') || fileRef.startsWith('http');

/** Download an image from OneBot and generate alt text via the shared image-to-text resolver. */
export const resolveOneBotImageAltText = async (
  att: CanonicalAttachment,
  caption: string,
  api: OneBotApiClient,
  resolver: ImageToTextResolver,
): Promise<void> => {
  if (!att.fileRef) return;

  try {
    // 1. Download the image
    const buffer = await api.downloadFile(att.fileRef, '');

    // 2. Generate thumbnail for cache key + rendering
    const thumbnailBuffer = await generateThumbnail(buffer);
    att.thumbnailWebp = thumbnailBuffer.toString('base64');

    // 3. Resolve via shared resolver (handles cache lookup + LLM)
    try {
      const record = await resolver.resolve(thumbnailBuffer, caption, buffer);
      att.altText = record.altText;
      if (record.stickerSetName) att.stickerSetName = record.stickerSetName;
    } catch {
      // LLM failure: leave altText unset, attachment still renders with thumbnail
    }
  } catch {
    // Download or thumbnail failure: leave attachment as-is
  }
};
