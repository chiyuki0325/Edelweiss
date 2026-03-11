// Rendering parameters — all provided by the Driver or computed at call time.
// In the theoretical model, render(IC) → RC with no extra parameters.
// In practice, these make the infinite IC/RC finite and add dynamic context.
export interface RenderParams {
  systemPrompt: string;
  // From Driver: compact cursor + summary make IC finite.
  compactCursor?: number;
  compactionSummary?: string;
  // TODO: Late-binding context (recalled memory, cross-session awareness, action directives)
  // will be injected at the end of the last user message. Exact fields TBD when implementing
  // the rendering layer. See docs/dcp-design.md §Rendering Parameters and §Cross-Session Interaction.
}

// Rendered Context (RC) — the output of the Rendering layer.
// A sequence of segments that the Driver interleaves with its Turns
// by timestamp to assemble the final LLM API request.

export interface RenderedSystemSegment {
  type: 'system';
  content: string;
}

// TODO: For multimodal support, content will need to become a structured
// Content[] with text and image_url parts instead of a single string.
export interface RenderedUserBatchSegment {
  type: 'user_batch';
  content: string;
}

export type RenderedSegment =
  | RenderedSystemSegment
  | RenderedUserBatchSegment;

export type RenderedContext = RenderedSegment[];
