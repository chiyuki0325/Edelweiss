import { describe, expect, it } from 'vitest';

import { adaptUser } from './adaptation';

describe('adaptUser', () => {
  it('prefers remark over group card and nickname', () => {
    expect(adaptUser(42, 'nickname', 'group card', 'remark').displayName).toBe('remark');
  });

  it('falls back from blank remark to group card', () => {
    expect(adaptUser(42, 'nickname', 'group card', '  ').displayName).toBe('group card');
  });

  it('falls back from blank group card to nickname', () => {
    expect(adaptUser(42, 'nickname', '', undefined).displayName).toBe('nickname');
  });
});
