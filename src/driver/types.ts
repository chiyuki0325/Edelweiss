import type { ResolvedChatConfig } from '../config/config';
import type { ConversationEntry } from '../unified-api/types';

export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  modelName: string;
  agentId?: string;
}

export interface ProbeResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  modelName: string;
  isActivated: boolean;
  createdAt: number;
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
  /** DeepSeek reasoning effort level ('low'/'medium' map to 'high', 'xhigh' maps to 'max'). Only for openai-chat provider. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
}

export interface DriverConfig {
  chatIds: string[];
  resolveChatConfig: (chatId: string) => ResolvedChatConfig;
}

export interface CompactionConfig {
  maxContextEstTokens: number;
  workingWindowEstTokens: number;
  model?: LlmEndpoint;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export type { ResolvedChatConfig } from '../config/config';

// --- Platform adapter ---

export interface SendMessageOptions {
  replyTo?: string;
  attachments?: {
    type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
    path: string;
    file_name?: string;
  }[];
}

export interface SentMessage {
  messageId: string;
}

export interface PlatformAdapter {
  kind: 'telegram' | 'onebot';
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<SentMessage>;
  downloadFile(identifier: string, chatId: string): Promise<Buffer>;
  downloadImage(identifier: string, chatId: string): Promise<Buffer>;
}
