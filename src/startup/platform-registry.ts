import type { PlatformAdapter } from '../driver/types';

export interface PlatformRegistry {
  getAdapter(chatId: string): PlatformAdapter | undefined;
  setAdapter(chatId: string, adapter: PlatformAdapter): void;
}

export const createPlatformRegistry = (): PlatformRegistry => {
  const adapters = new Map<string, PlatformAdapter>();
  return {
    getAdapter: chatId => adapters.get(chatId),
    setAdapter: (chatId, adapter) => {
      adapters.set(chatId, adapter);
    },
  };
};
