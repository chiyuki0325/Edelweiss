import sharp from 'sharp';

import type { Attachment } from './message';

export const generateThumbnail = async (buffer: Buffer): Promise<string> => {
  const webp = await sharp(buffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return webp.toString('base64');
};

const THUMBNAIL_TYPES = new Set(['photo', 'sticker']);

export const canGenerateThumbnail = (attachment: Attachment): boolean =>
  THUMBNAIL_TYPES.has(attachment.type)
  && !attachment.isAnimatedSticker
  && !attachment.isVideoSticker;
