export { createSemaphore, callDescriptionLlm } from './llm-description';

export { canExtractFrames, extractFrames, deduplicateFrames } from './frame-extractor';
export type { FrameExtractionResult } from './frame-extractor';

export { generateThumbnail, canGenerateThumbnail } from './thumbnail';

export { prepareImageToTextBuffer, computeThumbnailHash, createImageToTextResolver } from './image-to-text';
export type { ImageToTextCompressionConfig, ImageToTextResolveOptions, ImageAltTextRecord, ImageToTextResolver } from './image-to-text';
export { renderImageToTextSystemPrompt } from './image-to-text-prompt';

export { createAnimationToTextResolver } from './animation-to-text';
export type { AnimationToTextResolver } from './animation-to-text';
export { renderAnimationToTextSystemPrompt } from './animation-to-text-prompt';

export { createCustomEmojiToTextResolver, emojiCacheKey } from './custom-emoji-to-text';
export type { CustomEmojiToTextResolver } from './custom-emoji-to-text';
export { renderCustomEmojiToTextSystemPrompt } from './custom-emoji-to-text-prompt';
