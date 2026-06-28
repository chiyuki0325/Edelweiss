import type { ContentNode } from '../../adaption-types';
import { resolveChatConfig } from '../../config/config';
import { loadImageAltTextByHash } from '../../db';
import { emojiCacheKey } from '../../media/custom-emoji-to-text';
import { computeThumbnailHash } from '../../media/image-to-text';
import type { ImageToTextCompressionConfig } from '../../media/image-to-text';
import type { PipelineEvent } from '../../pipeline';
import type { Registrar } from '../registrar';
import type { AltTextPolicy } from '../tokens';
import { TOKENS } from '../tokens';

const walkCustomEmoji = (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => {
  for (const n of nodes) {
    if (n.type === 'custom_emoji') fn(n);
    if ('children' in n) walkCustomEmoji(n.children, fn);
  }
};

export default function registerAltTextPolicy({ get, register }: Registrar): void {
  register(TOKENS.ALT_TEXT_POLICY, (): AltTextPolicy => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const { imageToTextChatIds, animationToTextChatIds, customEmojiToTextChatIds } = get(TOKENS.FEATURE_SETS);
    const customEmojiResolver = get(TOKENS.CUSTOM_EMOJI_RESOLVER);

    const getImageToTextCompression = (chatId: string): ImageToTextCompressionConfig => {
      const cfg = resolveChatConfig(config, chatId).imageToText;
      return { compress: cfg.compress, pixelBudget: cfg.pixelBudget };
    };

    const hydrateAltTextFromCache = (event: PipelineEvent) => {
      if (event.type !== 'message' && event.type !== 'edit') return;
      for (const att of event.attachments) {
        if (att.altText) continue;
        if (att.thumbnailWebp && imageToTextChatIds.size > 0) {
          const cached = loadImageAltTextByHash(db, computeThumbnailHash(att.thumbnailWebp));
          if (cached) { att.altText = cached.altText; continue; }
        }
        if (att.animationHash && animationToTextChatIds.size > 0) {
          const cached = loadImageAltTextByHash(db, att.animationHash);
          if (cached) {
            att.altText = cached.altText;
            if (cached.stickerSetName) att.stickerSetName = cached.stickerSetName;
          }
        }
      }
      if (customEmojiToTextChatIds.size > 0) {
        walkCustomEmoji(event.content, node => {
          if (node.altText) return;
          const cached = loadImageAltTextByHash(db, emojiCacheKey(node.customEmojiId));
          if (cached) {
            node.altText = cached.altText;
            if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
          } else {
            const error = customEmojiResolver.getError(node.customEmojiId);
            if (error) node.altTextError = error;
          }
        });
      }
    };

    return { getImageToTextCompression, hydrateAltTextFromCache, walkCustomEmoji };
  });
}
