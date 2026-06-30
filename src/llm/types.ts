export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  /** Max concurrent description calls (image/animation/custom-emoji-to-text) for this endpoint. Defaults to 3; set to 1 to serialize. */
  descriptionConcurrency?: number;
  /** Extra fields shallow-merged into the request body. The endpoint's apiFormat
   * decides whether this is OpenAI Chat (`reasoning_effort`, `temperature`, ...),
   * Anthropic Messages (`thinking`, `max_tokens`, ...), or OpenAI Responses
   * (`reasoning`, `text`, ...). Caller is responsible for not stomping on
   * structural fields we set (model, messages, tools, etc.). */
  extraBody?: Record<string, unknown>;
  /** Force tool call. true = always call a tool */
  forceToolCall?: boolean | 'api' | 'local';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
