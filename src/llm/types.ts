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
  /** DeepSeek reasoning effort level ('low'/'medium' map to 'high', 'xhigh' maps to 'max'). Only for openai-chat provider. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  /** Force tool call. true = always call a tool */
  forceToolCall?: boolean | 'api' | 'local';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
