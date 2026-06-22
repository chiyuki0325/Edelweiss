import { describe, expect, it } from 'vitest';

import { createPlatformRegistry } from './platform-registry';
import type { PlatformAdapter } from '../driver/types';

describe('platform registry', () => {
  it('stores adapters by chat id', () => {
    const registry = createPlatformRegistry();
    const adapter: PlatformAdapter = {
      kind: 'onebot',
      sendMessage: async () => ({ messageId: '1' }),
      downloadFile: async () => Buffer.alloc(0),
      downloadImage: async () => Buffer.alloc(0),
    };

    expect(registry.getAdapter('chat-a')).toBeUndefined();
    registry.setAdapter('chat-a', adapter);
    expect(registry.getAdapter('chat-a')).toBe(adapter);
  });
});
