import { describe, expect, it, vi } from 'vitest';

import { normalizeStickerSetMetadata, resolveStickerSetMetadata } from './pack-title';

describe('resolveStickerSetMetadata', () => {
  it('resolves display title from raw stickerSetId', async () => {
    const resolvePackTitle = vi.fn(async (setName: string) => `${setName} Title`);

    await expect(resolveStickerSetMetadata({ stickerSetId: 'cats_by_alice' }, resolvePackTitle)).resolves.toEqual({
      stickerSetId: 'cats_by_alice',
      stickerSetName: 'cats_by_alice Title',
    });
    expect(resolvePackTitle).toHaveBeenCalledWith('cats_by_alice');
  });

  it('treats legacy stickerSetName-only data as raw set_name', async () => {
    const resolvePackTitle = vi.fn(async (setName: string) => `${setName} Title`);

    await expect(resolveStickerSetMetadata({ stickerSetName: 'legacy_pack' }, resolvePackTitle)).resolves.toEqual({
      stickerSetId: 'legacy_pack',
      stickerSetName: 'legacy_pack Title',
    });
    expect(resolvePackTitle).toHaveBeenCalledWith('legacy_pack');
  });
});

describe('normalizeStickerSetMetadata', () => {
  it('normalizes items in place and reports changes', async () => {
    const resolvePackTitle = vi.fn(async (setName: string) => `${setName} Title`);
    const items = [
      { stickerSetName: 'legacy_pack' },
      { stickerSetId: 'cats_by_alice', stickerSetName: 'Wrong Title' },
      {},
    ];

    await expect(normalizeStickerSetMetadata(items, resolvePackTitle)).resolves.toBe(true);
    expect(items).toEqual([
      { stickerSetId: 'legacy_pack', stickerSetName: 'legacy_pack Title' },
      { stickerSetId: 'cats_by_alice', stickerSetName: 'cats_by_alice Title' },
      {},
    ]);
  });

  it('returns false for empty inputs', async () => {
    const resolvePackTitle = vi.fn(async (setName: string) => `${setName} Title`);

    await expect(normalizeStickerSetMetadata(undefined, resolvePackTitle)).resolves.toBe(false);
    expect(resolvePackTitle).not.toHaveBeenCalled();
  });
});
