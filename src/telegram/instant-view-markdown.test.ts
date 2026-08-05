import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';

import { renderInstantViewMarkdown } from './instant-view-markdown';
import { parseInstantViewPhotoUrl } from './instant-view-url';

const plain = (text: string) => new Api.TextPlain({ text });
const caption = (text = '') => new Api.PageCaption({ text: plain(text), credit: new Api.TextEmpty() });

describe('renderInstantViewMarkdown', () => {
  it('renders readable text and resolvable photo references', () => {
    const photo = new Api.Photo({
      id: bigInt('6027322997883997673'),
      accessHash: bigInt(2),
      fileReference: Buffer.alloc(0),
      date: 0,
      sizes: [],
      dcId: 1,
    });
    const page = new Api.Page({
      url: 'https://example.com/article',
      blocks: [
        new Api.PageBlockTitle({ text: plain('Example') }),
        new Api.PageBlockParagraph({ text: new Api.TextBold({ text: plain('Body') }) }),
        new Api.PageBlockPhoto({ photoId: photo.id, caption: caption('Diagram') }),
      ],
      photos: [photo],
      documents: [],
    });

    const result = renderInstantViewMarkdown(page, page.url);
    expect(result.content).toContain('<!-- Rendered from InstantView; use read_image');
    expect(result.content).toContain('# Example');
    expect(result.content).toContain('**Body**');

    const target = result.content.match(/\]\(<(telegram:[^)]+)>\)/)?.[1];
    expect(target).toBeDefined();
    expect(parseInstantViewPhotoUrl(target!)).toEqual({
      pageUrl: 'https://example.com/article',
      photoId: '6027322997883997673',
    });
  });
});
