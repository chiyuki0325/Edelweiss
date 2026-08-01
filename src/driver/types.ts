import type { ResolvedChatConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry } from '../unified-api/types';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  modelName: string;
  agentId?: string;
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

export type ManualCompactionResult =
  | { status: 'completed'; meta: CompactionSessionMeta }
  | { status: 'skipped'; reason: 'no_content' | 'within_working_window' };

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
