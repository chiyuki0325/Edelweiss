import { describe, expect, it } from 'vitest';

import { formatInstantViewPhotoUrl, parseInstantViewPhotoUrl } from './instant-view-url';

describe('Instant View photo URLs', () => {
  it('round-trips a page URL containing its own query string', () => {
    const reference = {
      pageUrl: 'https://t.me/iv?url=https%3A%2F%2Fexample.com%2Fpost&hash=abc',
      photoId: '6027322997883997673',
    };
    const url = formatInstantViewPhotoUrl(reference);

    expect(url).toMatch(/^telegram:\/\/instant-view\/photo\/6027322997883997673\?url=/);
    expect(parseInstantViewPhotoUrl(url)).toEqual(reference);
  });

  it('rejects malformed or non-HTTP references', () => {
    expect(parseInstantViewPhotoUrl('telegram://instant-view/photo/nope?url=https://example.com')).toBeUndefined();
    expect(parseInstantViewPhotoUrl('telegram://instant-view/photo/1?url=file:///etc/passwd')).toBeUndefined();
    expect(parseInstantViewPhotoUrl('telegram://other/photo/1?url=https://example.com')).toBeUndefined();
  });
});
