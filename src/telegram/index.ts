import type { TelegramDriverHooks } from './driver-hooks';
import type { TelegramLiveHandlers } from './live-handlers';
import type { TelegramManager } from './manager';
import type { TelegramPostStartupTasks } from './post-startup';

export { createTelegramCustomEmojiResolver } from './custom-emoji-resolver';
export { createTelegramDriverHooks } from './driver-hooks';
export type { TelegramDriverHooks, TelegramDriverHooksDeps } from './driver-hooks';
export { createTelegramEventSink } from './event-sink';
export type { TelegramEventSink, TelegramEventSinkDeps } from './event-sink';
export { createTelegramLiveHandlers } from './live-handlers';
export type { TelegramChatPolicy, TelegramDriverControl, TelegramLiveHandlers, TelegramLiveHandlersDeps } from './live-handlers';
export { createTelegramManager, createTelegramStartupManager } from './manager';
export type { TelegramManager, TelegramManagerDeps, TelegramManagerOptions } from './manager';
export { createTelegramPostStartupTasks } from './post-startup';
export type { TelegramPostStartupDeps, TelegramPostStartupTasks } from './post-startup';
export type { TelegramMessageStore, TelegramReactionStore } from './stores';

export interface TelegramStartupHandle {
  manager: TelegramManager;
  driverHooks: TelegramDriverHooks;
  startLiveHandlers(): Promise<void>;
  runPostStartupTasks(): Promise<void>;
  stop(): Promise<void>;
}

export const startTelegram = (deps: {
  manager: TelegramManager;
  driverHooks: TelegramDriverHooks;
  liveHandlers: TelegramLiveHandlers;
  postStartupTasks: TelegramPostStartupTasks;
}): TelegramStartupHandle => ({
  manager: deps.manager,
  driverHooks: deps.driverHooks,
  startLiveHandlers: () => deps.liveHandlers.start(),
  runPostStartupTasks: () => deps.postStartupTasks.run(),
  stop: () => deps.manager.stop(),
});
