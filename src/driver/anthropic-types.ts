// Anthropic Messages API wire format types.
// Used only at the API boundary — never stored in DB.
// Storage types (AnthropicAssistantEntry, AnthropicToolResultGroupEntry, etc.) are in types.ts.

export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;

export interface AnthropicUserMessage {
  role: 'user';
  content: string | AnthropicUserContentBlock[];
}

export interface AnthropicAssistantMessage {
  role: 'assistant';
  content: AnthropicAssistantContentBlock[];
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

// System content block — used when system needs cache_control (array form).
export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}
