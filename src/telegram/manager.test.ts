import { describe, expect, it } from 'vitest';

import { shouldAutoDescribeImageAttachment } from './manager';

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
