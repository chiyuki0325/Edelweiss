import type { Logger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { renderTextToSegments } from './send';
import type { CodeBlockRenderer } from './send';

describe('renderTextToSegments', () => {
  it('renders fenced code blocks as OneBot image segments', async () => {
    const renderCodeBlock = vi.fn<CodeBlockRenderer>(async () => Buffer.from('png'));

    const segments = await renderTextToSegments([
      'before **bold**',
      '```ts',
      'const answer = 42;',
      '```',
      'after',
    ].join('\n'), { renderCodeBlock });

    expect(renderCodeBlock).toHaveBeenCalledWith('const answer = 42;', 'ts');
    expect(segments).toEqual([
      { type: 'text', data: { text: 'before bold' } },
      { type: 'image', data: { file: 'base64://cG5n' } },
      { type: 'text', data: { text: 'after' } },
    ]);
  });

  it('falls back to plain text and warns when silicon rendering fails', async () => {
    const warn = vi.fn();
    const logger = {
      withError: vi.fn(() => ({ warn })),
    } as unknown as Logger;
    const renderCodeBlock = vi.fn<CodeBlockRenderer>(async () => {
      throw new Error('missing silicon');
    });

    const segments = await renderTextToSegments([
      'before',
      '```js',
      'console.log("x");',
      '```',
      'after',
    ].join('\n'), { renderCodeBlock, logger });

    expect(segments).toEqual([
      { type: 'text', data: { text: 'before' } },
      { type: 'text', data: { text: '```js\nconsole.log("x");\n```' } },
      { type: 'text', data: { text: 'after' } },
    ]);
    expect(logger.withError).toHaveBeenCalledWith(expect.any(Error));
    expect(warn).toHaveBeenCalledWith('Failed to render OneBot code block with silicon; falling back to plain text');
  });

  it('keeps non-code markdown on the existing plain-text path', async () => {
    const renderCodeBlock = vi.fn<CodeBlockRenderer>();

    await expect(renderTextToSegments('**hi** [docs](https://example.com) `x`', { renderCodeBlock })).resolves.toEqual([
      { type: 'text', data: { text: 'hi docs (https://example.com) x' } },
    ]);
    expect(renderCodeBlock).not.toHaveBeenCalled();
  });
});
