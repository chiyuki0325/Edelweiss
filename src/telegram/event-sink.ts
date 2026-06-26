import type { PipelineEvent } from '../pipeline';
import type { RenderedContext } from '../rendering';
import { isConfiguredChat } from '../startup/chat-selection';

export interface TelegramEventSink {
  persist(event: PipelineEvent): void;
  publish(event: PipelineEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
  accept(event: PipelineEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
  isConfiguredChat(chatId: string): boolean;
}

export interface TelegramEventSinkDeps {
  configuredChatIds: ReadonlySet<string>;
  persistEvent: (event: PipelineEvent) => void;
  hydrateAltTextFromCache: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext;
  onDriverEvent: (chatId: string, rc: RenderedContext) => void;
}

export const createTelegramEventSink = (deps: TelegramEventSinkDeps): TelegramEventSink => {
  const isConfigured = (chatId: string) => isConfiguredChat(deps.configuredChatIds, chatId);

  return {
    persist: event => {
      deps.persistEvent(event);
    },
    publish: (event, options = {}) => {
      if (options.hydrateAltText) deps.hydrateAltTextFromCache(event);
      if (!isConfigured(event.chatId)) return undefined;

      const rc = deps.pushPipelineEvent(event.chatId, event);
      if (options.notifyDriver) deps.onDriverEvent(event.chatId, rc);
      return rc;
    },
    accept(event, options) {
      this.persist(event);
      return this.publish(event, options);
    },
    isConfiguredChat: isConfigured,
  };
};
