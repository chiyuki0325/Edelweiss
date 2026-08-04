import { describe, expect, it } from 'vitest';

import { createAssociatedChannelResolver, shouldAutoDescribeImageAttachment } from './manager';

describe('shouldAutoDescribeImageAttachment', () => {
  it('disables automatic description for spoiler photos', () => {
    expect(shouldAutoDescribeImageAttachment({ type: 'photo', hasSpoiler: true })).toBe(false);
  });

  it('keeps automatic description for ordinary photos', () => {
    expect(shouldAutoDescribeImageAttachment({ type: 'photo' })).toBe(true);
  });

  it('does not change non-photo attachment handling', () => {
    expect(shouldAutoDescribeImageAttachment({ type: 'animation', hasSpoiler: true })).toBe(true);
  });
});

describe('createAssociatedChannelResolver', () => {
  it('recognizes only posts from the group linked channel and caches the lookup', async () => {
    let calls = 0;
    const resolve = createAssociatedChannelResolver(async chatId => {
      calls++;
      expect(chatId).toBe('-100group');
      return '-100channel';
    });

    await expect(resolve('-100group', '-100channel', true)).resolves.toBe(true);
    await expect(resolve('-100group', '-100other', true)).resolves.toBe(false);
    await expect(resolve('-100group', '-100channel', false)).resolves.toBe(false);
    await expect(resolve('-100group')).resolves.toBe(false);
    expect(calls).toBe(1);
  });

  it('does not retain a failed lookup, allowing a later message to retry', async () => {
    let calls = 0;
    const resolve = createAssociatedChannelResolver(async () => {
      calls++;
      if (calls === 1) throw new Error('temporary API failure');
      return '-100channel';
    });

    await expect(resolve('-100group', '-100channel', true)).rejects.toThrow('temporary API failure');
    await expect(resolve('-100group', '-100channel', true)).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
