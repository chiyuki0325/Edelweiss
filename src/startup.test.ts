import { describe, expect, it } from 'vitest';

import { isConfiguredChat, selectStartupReplayChatIds, selectTelegramIngressChatIds } from './startup';

describe('startup chat selection', () => {
  it('replays only chats that are both known in the DB and configured', () => {
    expect(selectStartupReplayChatIds(
      ['configured-a', 'archived-chat', 'configured-b'],
      ['configured-b', 'configured-a', 'new-configured-chat'],
    )).toEqual(['configured-a', 'configured-b']);
  });

  it('keeps only configured chats in the in-memory pipeline', () => {
    const configured = new Set(['configured-chat']);

    expect(isConfiguredChat(configured, 'configured-chat')).toBe(true);
    expect(isConfiguredChat(configured, 'archived-chat')).toBe(false);
  });

  it('accepts configured Telegram chats even when no persisted context remains', () => {
    expect(selectTelegramIngressChatIds(
      ['archived-chat', 'configured-with-history'],
      ['configured-with-history', 'context-deleted-chat'],
    )).toEqual(['archived-chat', 'configured-with-history', 'context-deleted-chat']);
  });
});
