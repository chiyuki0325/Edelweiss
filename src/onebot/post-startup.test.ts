import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createOneBotPostStartupTasks } from './post-startup';
import type { OneBotPostStartupDeps } from './post-startup';
import type { OneBotApiClient } from './server';
import type { CanonicalAttachment, CanonicalMessageEvent } from '../adaption-types';
import { setupLogger, useLogger } from '../config/logger';
import type { EventWithId } from '../db/persistence';
import type { ImageAltTextRecord, ImageToTextResolver } from '../media/image-to-text';

setupLogger();

let pngBuffer: Buffer;

beforeAll(async () => {
  pngBuffer = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
  }).png().toBuffer();
});

const messageEvent = (messageId: string, attachments: CanonicalAttachment[]): CanonicalMessageEvent => ({
  type: 'message',
  chatId: '100',
  messageId,
  sender: { id: '42', displayName: 'alice', isBot: false },
  receivedAtMs: 1000,
  timestampSec: 1,
  utcOffsetMin: 0,
  content: [{ type: 'text', text: 'look' }],
  attachments,
});

const stubResolver = (altText: string): ImageToTextResolver => ({
  resolve: () => Promise.resolve({ imageHash: 'h', altText, altTextTokens: 1 } as ImageAltTextRecord),
  hydrateCanonicalAttachments: () => Promise.resolve(),
});

const stubApi = (buffer: Buffer): OneBotApiClient => ({
  downloadFile: () => Promise.resolve(buffer),
} as unknown as OneBotApiClient);

const baseDeps = (overrides: Partial<OneBotPostStartupDeps>): OneBotPostStartupDeps => ({
  logger: useLogger('test') as unknown as Logger,
  getApi: () => stubApi(pngBuffer),
  imageToTextChatIds: new Set(['100']),
  imageToTextResolver: stubResolver('a red square'),
  animationToTextResolver: { resolve: () => Promise.reject(new Error('unused')) } as never,
  getImageToTextCompression: () => ({ compress: true, pixelBudget: 512 * 512 }),
  resolveChatPlatform: () => 'onebot',
  loadCompaction: () => null,
  loadEventsWithId: () => [],
  updateEventAttachments: () => {},
  hydrateAltTextFromCache: () => {},
  replayChat: () => ({} as never),
  getRenderedContext: () => undefined,
  onDriverEvent: () => {},
  ...overrides,
});

describe('createOneBotPostStartupTasks', () => {
  it('resolves alt text for historical photo events lacking it and persists back', async () => {
    const photo: CanonicalAttachment = { type: 'photo', fileRef: 'abc.png' };
    const events: EventWithId[] = [{ id: 7, event: messageEvent('1', [photo]) }];
    const updated = vi.fn();

    const tasks = createOneBotPostStartupTasks(baseDeps({
      loadEventsWithId: () => events,
      updateEventAttachments: (id, atts) => updated(id, atts),
    }));

    await tasks.run();

    expect(photo.altText).toBe('a red square');
    expect(updated).toHaveBeenCalledWith(7, [photo]);
  });

  it('skips events whose attachments already have alt text', async () => {
    const photo: CanonicalAttachment = { type: 'photo', fileRef: 'abc.png', altText: 'cached' };
    const updated = vi.fn();

    const tasks = createOneBotPostStartupTasks(baseDeps({
      loadEventsWithId: () => [{ id: 9, event: messageEvent('1', [photo]) }],
      updateEventAttachments: (id, atts) => updated(id, atts),
    }));

    await tasks.run();

    expect(photo.altText).toBe('cached');
    expect(updated).not.toHaveBeenCalled();
  });

  it('does not abort when resolution fails (best-effort backfill)', async () => {
    const photo: CanonicalAttachment = { type: 'photo', fileRef: 'expired.png' };
    const updated = vi.fn();

    const tasks = createOneBotPostStartupTasks(baseDeps({
      getApi: () => ({ downloadFile: () => Promise.reject(new Error('expired media')) } as unknown as OneBotApiClient),
      loadEventsWithId: () => [{ id: 3, event: messageEvent('1', [photo]) }],
      updateEventAttachments: (id, atts) => updated(id, atts),
    }));

    await expect(tasks.run()).resolves.toBeUndefined();
    expect(photo.altText).toBeUndefined();
    expect(updated).not.toHaveBeenCalled();
  });

  it('ignores chats on other platforms', async () => {
    const photo: CanonicalAttachment = { type: 'photo', fileRef: 'abc.png' };
    const loadEventsWithId = vi.fn(() => [{ id: 1, event: messageEvent('1', [photo]) }]);

    const tasks = createOneBotPostStartupTasks(baseDeps({
      resolveChatPlatform: () => 'telegram',
      loadEventsWithId,
    }));

    await tasks.run();

    expect(loadEventsWithId).not.toHaveBeenCalled();
    expect(photo.altText).toBeUndefined();
  });
});
