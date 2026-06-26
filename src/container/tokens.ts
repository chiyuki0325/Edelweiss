import type { Logger } from '@guiiai/logg';

import type { CanonicalBlockedMessageEvent, CanonicalMessageEvent, ContentNode } from '../adaptation/types';
import type { createBackgroundTaskManager } from '../background-task/manager';
import type { BackgroundTasksConfig, Config, RuntimeConfig } from '../config/config';
import type { DB } from '../db/client';
import type { createDriver } from '../driver';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { CustomEmojiToTextResolver } from '../media/custom-emoji-to-text';
import type { ImageToTextCompressionConfig, ImageToTextResolver } from '../media/image-to-text';
import type { createSemaphore } from '../media/llm-description';
import type { OneBotStartupHandle } from '../onebot/startup';
import type { createPipeline, PipelineEvent } from '../pipeline';
import type { RenderParams } from '../rendering';
import type { PlatformRegistry } from '../startup/platform-registry';
import type { TelegramStartupHandle } from '../telegram/startup';

export type Pipeline = ReturnType<typeof createPipeline>;
export type Driver = ReturnType<typeof createDriver>;
export type BackgroundTaskManager = ReturnType<typeof createBackgroundTaskManager>;
export type Semaphore = ReturnType<typeof createSemaphore>;

// Per-feature chat-id enablement sets, derived once from config. Lives in its
// own token so both the alt-text policy and the resolvers can read it without
// a circular dependency (the custom-emoji resolver needs the sets, and the
// alt-text policy needs the custom-emoji resolver).
export interface FeatureSets {
  imageToTextChatIds: ReadonlySet<string>;
  animationToTextChatIds: ReadonlySet<string>;
  customEmojiToTextChatIds: ReadonlySet<string>;
}

// Blocking / redaction policy derived from per-chat blockedUserIds config.
export interface ChatPolicy {
  isBlocked: (chatId: string, senderId: string | undefined) => boolean;
  toBlockedMessageEvent: (event: CanonicalMessageEvent) => CanonicalBlockedMessageEvent;
  redactBlockedMessage: (event: CanonicalMessageEvent) => CanonicalMessageEvent | CanonicalBlockedMessageEvent;
  blockedUserIdsByChat: ReadonlyMap<string, ReadonlySet<string>>;
}

// Alt-text hydration policy. The per-feature enablement sets live in FeatureSets.
export interface AltTextPolicy {
  getImageToTextCompression: (chatId: string) => ImageToTextCompressionConfig;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  walkCustomEmoji: (nodes: ContentNode[], fn: (node: Extract<ContentNode, { type: 'custom_emoji' }>) => void) => void;
}

// Per-model description-LLM semaphore lookup. Resolvers sharing the same model
// endpoint share one concurrency limit; the getter memoizes per model key.
export interface DescriptionSemaphores {
  get: (modelKey: string | undefined) => Semaphore | undefined;
}

// Late-bound holder for the OneBot handle: it is built asynchronously
// (startOneBot awaits a WS client), so it cannot be a synchronous useFactory
// singleton. The orchestrator assigns `handle` after the await.
export interface OneBotHolder {
  handle: OneBotStartupHandle | undefined;
}

// Phantom-typed token. The symbol is the runtime key passed to tsyringe;
// the `_t` field only carries the resolved type for the typed register/resolve
// helpers in ./index.ts. It is never read at runtime.
export interface Token<T> {
  readonly sym: symbol;
  readonly _t?: (x: T) => T;
}

const token = <T>(name: string): Token<T> => ({ sym: Symbol(name) });

export const TOKENS = {
  CONFIG: token<Config>('Config'),
  RUNTIME_CONFIG: token<RuntimeConfig>('RuntimeConfig'),
  BG_TASKS_CONFIG: token<BackgroundTasksConfig>('BackgroundTasksConfig'),
  LOGGER: token<Logger>('Logger'),
  DB: token<DB>('Db'),
  RENDER_PARAMS: token<RenderParams>('RenderParams'),
  PIPELINE: token<Pipeline>('Pipeline'),
  PLATFORM_REGISTRY: token<PlatformRegistry>('PlatformRegistry'),
  FEATURE_SETS: token<FeatureSets>('FeatureSets'),
  DESCRIPTION_SEMAPHORES: token<DescriptionSemaphores>('DescriptionSemaphores'),
  CHAT_POLICY: token<ChatPolicy>('ChatPolicy'),
  ALT_TEXT_POLICY: token<AltTextPolicy>('AltTextPolicy'),
  IMAGE_TO_TEXT_RESOLVER: token<ImageToTextResolver>('ImageToTextResolver'),
  ANIMATION_TO_TEXT_RESOLVER: token<AnimationToTextResolver>('AnimationToTextResolver'),
  CUSTOM_EMOJI_RESOLVER: token<CustomEmojiToTextResolver>('CustomEmojiToTextResolver'),
  TELEGRAM: token<TelegramStartupHandle | undefined>('Telegram'),
  ONEBOT: token<OneBotHolder>('OneBot'),
  BACKGROUND_TASK_MANAGER: token<BackgroundTaskManager>('BackgroundTaskManager'),
  DRIVER: token<Driver>('Driver'),
} as const;
