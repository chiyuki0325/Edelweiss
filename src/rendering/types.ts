export interface SessionState {
  systemPrompt: string;
  // Rendering skips IC nodes at or before this cursor, replacing them with compactionSummary.
  compactCursor?: number;
  compactionSummary?: string;
  // TODO: Late-binding context (recalled memory, cross-session awareness, action directives)
  // will be injected at the end of the last user message. Exact fields TBD when implementing
  // the rendering layer — see DCP RFC §记忆注入 and Gemini chat Turn 24.
}

// TODO: For multimodal support (thumbnails as inline images), content will need
// to become a structured Content[] with text and image_url parts instead of a
// single string. Redesign when implementing the rendering layer.
export interface RenderedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type RenderedOutput = RenderedMessage[];
