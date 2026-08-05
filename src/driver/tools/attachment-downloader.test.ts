import { describe, expect, it, vi } from 'vitest';

import { createAttachmentDownloader } from './attachment-downloader';
import { formatInstantViewPhotoUrl } from '../../telegram/instant-view-url';

describe('createAttachmentDownloader', () => {
  it('routes Instant View photo URLs to the Telegram photo downloader', async () => {
    const downloadInstantViewPhoto = vi.fn(async () => Buffer.from('photo'));
    const download = createAttachmentDownloader({
      chatId: 'chat-1',
      loadMessageAttachments: () => undefined,
      downloadFile: async () => { throw new Error('unused'); },
      downloadInstantViewPhoto,
    });
    const fileId = formatInstantViewPhotoUrl({ pageUrl: 'https://example.com/article', photoId: '42' });

    await expect(download(fileId)).resolves.toEqual(Buffer.from('photo'));
    expect(downloadInstantViewPhoto).toHaveBeenCalledWith({
      pageUrl: 'https://example.com/article',
      photoId: '42',
    });
  });
});
