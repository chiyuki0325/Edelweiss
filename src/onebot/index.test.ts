import { describe, expect, it, vi } from 'vitest';

import { buildOneBotSelfSentEvent, createOneBotPlatformAdapter } from './index';
import type { OneBotApiClient } from './server';
import type { CanonicalMessageEvent } from '../adaption-types';
import type { RuntimeConfig } from '../config/config';
import type { PipelineEvent } from '../pipeline';

const runtimeConfig = {
  readFile: ['cat'],
  readFileSizeLimit: 1024 * 1024,
} as unknown as RuntimeConfig;

const stubApi = (messageId: string): OneBotApiClient => ({
  sendMessage: vi.fn(async () => ({ messageId })),
  downloadFile: vi.fn(async () => Buffer.alloc(0)),
  getGroupMemberInfo: vi.fn(async () => ({ id: '0', displayName: 'x', isBot: false })),
  getChatName: vi.fn(async () => 'test chat'),
  getFriendRemark: vi.fn(async () => undefined),
  fetchMessages: vi.fn(async () => []),
});

describe('buildOneBotSelfSentEvent', () => {
  it('marks the event isSelfSent and derives timestampSec from receivedAtMs', () => {
    const event = buildOneBotSelfSentEvent({
      chatId: '100',
      messageId: '42',
      selfId: '999',
      text: 'hello',
      receivedAtMs: 1_700_000_500_123,
      utcOffsetMin: 480,
    });

    expect(event.type).toBe('message');
    expect(event.isSelfSent).toBe(true);
    expect(event.chatId).toBe('100');
    expect(event.messageId).toBe('42');
    expect(event.sender).toEqual({ id: '999', displayName: '999', isBot: true });
    expect(event.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(event.receivedAtMs).toBe(1_700_000_500_123);
    expect(event.timestampSec).toBe(Math.floor(1_700_000_500_123 / 1000));
    expect(event.utcOffsetMin).toBe(480);
    expect(event.attachments).toEqual([]);
  });

  it('carries replyToMessageId when provided and empty content for empty text', () => {
    const event = buildOneBotSelfSentEvent({
      chatId: '100',
      messageId: '43',
      selfId: '999',
      text: '',
      replyToMessageId: '7',
    });
    expect(event.replyToMessageId).toBe('7');
    expect(event.content).toEqual([]);
  });
});

describe('createOneBotPlatformAdapter self-sent injection', () => {
  it('uses the current API after reconnect and fails while disconnected', async () => {
    const firstApi = stubApi('first');
    const secondApi = stubApi('second');
    let currentApi: OneBotApiClient | null = firstApi;
    const adapter = createOneBotPlatformAdapter({
      getApi: () => currentApi,
      runtime: runtimeConfig,
    });

    await expect(adapter.sendMessage('100', 'first')).resolves.toEqual({ messageId: 'first' });
    currentApi = null;
    await expect(adapter.sendMessage('100', 'offline')).rejects.toThrow('OneBot is disconnected');
    currentApi = secondApi;
    await expect(adapter.sendMessage('100', 'second')).resolves.toEqual({ messageId: 'second' });

    expect(firstApi.sendMessage).toHaveBeenCalledOnce();
    expect(secondApi.sendMessage).toHaveBeenCalledOnce();
  });

  it('persists, hydrates, and pushes the self-sent event after a successful send', async () => {
    const persisted: PipelineEvent[] = [];
    const hydrated: PipelineEvent[] = [];
    const pushed: { chatId: string; event: PipelineEvent }[] = [];

    const adapter = createOneBotPlatformAdapter({
      getApi: () => stubApi('555'),
      runtime: runtimeConfig,
      selfSentSink: {
        getSelfId: () => '999',
        persistEvent: e => persisted.push(e),
        hydrateAltTextFromCache: e => hydrated.push(e),
        pushPipelineEvent: (chatId, event) => pushed.push({ chatId, event }),
      },
    });

    const sent = await adapter.sendMessage('100', 'hi there', { replyTo: '7' });
    expect(sent.messageId).toBe('555');

    expect(persisted).toHaveLength(1);
    const event = persisted[0] as CanonicalMessageEvent;
    expect(event.isSelfSent).toBe(true);
    expect(event.chatId).toBe('100');
    expect(event.messageId).toBe('555');
    expect(event.replyToMessageId).toBe('7');
    expect(event.content).toEqual([{ type: 'text', text: 'hi there' }]);

    // Ordering: persist → hydrate → push, all on the same event instance.
    expect(hydrated[0]).toBe(event);
    expect(pushed[0]!.event).toBe(event);
    expect(pushed[0]!.chatId).toBe('100');
  });

  it('skips injection when self id is unavailable', async () => {
    const persisted: PipelineEvent[] = [];
    const adapter = createOneBotPlatformAdapter({
      getApi: () => stubApi('555'),
      runtime: runtimeConfig,
      selfSentSink: {
        getSelfId: () => null,
        persistEvent: e => persisted.push(e),
        hydrateAltTextFromCache: () => {},
        pushPipelineEvent: () => {},
      },
    });

    await adapter.sendMessage('100', 'hi');
    expect(persisted).toHaveLength(0);
  });

  it('does not inject when no sink is configured', async () => {
    const adapter = createOneBotPlatformAdapter({
      getApi: () => stubApi('555'),
      runtime: runtimeConfig,
    });
    const sent = await adapter.sendMessage('100', 'hi');
    expect(sent.messageId).toBe('555');
  });
});
