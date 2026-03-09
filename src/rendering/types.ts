export interface SessionState {
  systemPrompt: string;
  compactionSummary?: string;
  lateBindingContext?: string;
}

// TODO: For multimodal support (thumbnails as inline images), content will need
// to become a structured Content[] with text and image_url parts instead of a
// single string. Redesign when implementing the rendering layer.
export interface RenderedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type RenderedOutput = RenderedMessage[];
