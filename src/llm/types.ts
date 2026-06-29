export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface ThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: string;
}

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  /** Max concurrent description calls (image/animation/custom-emoji-to-text) for this endpoint. Defaults to 3; set to 1 to serialize. */
  descriptionConcurrency?: number;
  /** Per-model thinking/reasoning config, mapped to each provider format at the API boundary. */
  thinking?: ThinkingConfig;
  /** Force tool call. true = always call a tool */
  forceToolCall?: boolean | 'api' | 'local';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
