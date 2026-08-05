import { Api } from 'telegram';

import { formatInstantViewPhotoUrl } from './instant-view-url';

export interface InstantViewMarkdownResult {
  content: string;
  hasPhotos: boolean;
}

interface RenderState {
  pageUrl: string;
  photoIds: ReadonlySet<string>;
  hasPhotos: boolean;
}

const escapeText = (value: string): string =>
  value.replace(/([\\`*_[\]<>#|])/g, '\\$1');

const escapeLinkDestination = (value: string): string =>
  value.replaceAll(' ', '%20').replaceAll('>', '%3E');

const inlineCode = (value: string): string => {
  const delimiter = value.includes('`') ? '``' : '`';
  return `${delimiter}${value}${delimiter}`;
};

const richTextToPlainText = (text: Api.TypeRichText): string => {
  if (text instanceof Api.TextEmpty) return '';
  if (text instanceof Api.TextPlain) return text.text;
  if (text instanceof Api.TextConcat) return text.texts.map(richTextToPlainText).join('');
  if (text instanceof Api.TextImage) return `[Inline image ${text.w}x${text.h}]`;
  return richTextToPlainText(text.text);
};

const renderRichText = (text: Api.TypeRichText): string => {
  if (text instanceof Api.TextEmpty) return '';
  if (text instanceof Api.TextPlain) return escapeText(text.text);
  if (text instanceof Api.TextBold) return `**${renderRichText(text.text)}**`;
  if (text instanceof Api.TextItalic) return `*${renderRichText(text.text)}*`;
  if (text instanceof Api.TextUnderline) return `<u>${renderRichText(text.text)}</u>`;
  if (text instanceof Api.TextStrike) return `~~${renderRichText(text.text)}~~`;
  if (text instanceof Api.TextFixed) return inlineCode(richTextToPlainText(text.text));
  if (text instanceof Api.TextUrl)
    return `[${renderRichText(text.text)}](<${escapeLinkDestination(text.url)}>)`;
  if (text instanceof Api.TextEmail)
    return `[${renderRichText(text.text)}](<mailto:${escapeLinkDestination(text.email)}>)`;
  if (text instanceof Api.TextConcat) return text.texts.map(renderRichText).join('');
  if (text instanceof Api.TextSubscript) return `<sub>${renderRichText(text.text)}</sub>`;
  if (text instanceof Api.TextSuperscript) return `<sup>${renderRichText(text.text)}</sup>`;
  if (text instanceof Api.TextMarked) return `==${renderRichText(text.text)}==`;
  if (text instanceof Api.TextPhone)
    return `[${renderRichText(text.text)}](<tel:${escapeLinkDestination(text.phone)}>)`;
  if (text instanceof Api.TextImage) return `[Inline image ${text.w}x${text.h}]`;
  if (text instanceof Api.TextAnchor) return renderRichText(text.text);
  return '[Unsupported rich text]';
};

const captionText = (caption: Api.TypePageCaption): string => {
  if (!(caption instanceof Api.PageCaption)) return '';
  const text = renderRichText(caption.text);
  const credit = renderRichText(caption.credit);
  return [text, credit && `Credit: ${credit}`].filter(Boolean).join(' — ');
};

const indent = (value: string, prefix: string): string =>
  value.split('\n').map(line => `${prefix}${line}`).join('\n');

const renderBlocks = (blocks: Api.TypePageBlock[], state: RenderState): string =>
  blocks.map(block => renderBlock(block, state)).filter(Boolean).join('\n\n');

const renderUnorderedList = (items: Api.TypePageListItem[], state: RenderState): string =>
  items.map(item => {
    const content = item instanceof Api.PageListItemText
      ? renderRichText(item.text)
      : item instanceof Api.PageListItemBlocks
        ? renderBlocks(item.blocks, state)
        : '[Unsupported list item]';
    return indent(content, '- ').replaceAll('\n- ', '\n  ');
  }).join('\n');

const renderOrderedList = (items: Api.TypePageListOrderedItem[], state: RenderState): string =>
  items.map((item, index) => {
    const number = 'num' in item && item.num ? item.num : `${index + 1}.`;
    const content = item instanceof Api.PageListOrderedItemText
      ? renderRichText(item.text)
      : item instanceof Api.PageListOrderedItemBlocks
        ? renderBlocks(item.blocks, state)
        : '[Unsupported ordered-list item]';
    const prefix = number.endsWith('.') ? `${number} ` : `${number}. `;
    return indent(content, prefix).replaceAll(`\n${prefix}`, `\n${' '.repeat(prefix.length)}`);
  }).join('\n');

const renderTable = (block: Api.PageBlockTable): string => {
  const rows = block.rows
    .filter((row): row is Api.PageTableRow => row instanceof Api.PageTableRow)
    .map(row => row.cells.map(cell =>
      cell instanceof Api.PageTableCell && cell.text
        ? renderRichText(cell.text).replaceAll('|', '\\|').replaceAll('\n', '<br>')
        : ''));
  if (rows.length === 0) return renderRichText(block.title);
  const width = Math.max(...rows.map(row => row.length));
  const normalized = rows.map(row => [...row, ...Array<string>(width - row.length).fill('')]);
  const title = renderRichText(block.title);
  const table = [
    `| ${normalized[0]!.join(' | ')} |`,
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
  return [title && `**${title}**`, table].filter(Boolean).join('\n\n');
};

const renderPhoto = (photoId: string, caption: string, state: RenderState): string => {
  if (!state.photoIds.has(photoId))
    return caption || `[Unavailable Instant View photo ${photoId}]`;
  state.hasPhotos = true;
  const url = formatInstantViewPhotoUrl({ pageUrl: state.pageUrl, photoId });
  return `![${caption || 'Instant View photo'}](<${url}>)`;
};

const renderBlock = (block: Api.TypePageBlock, state: RenderState): string => {
  if (block instanceof Api.PageBlockTitle) return `# ${renderRichText(block.text)}`;
  if (block instanceof Api.PageBlockSubtitle) return `## ${renderRichText(block.text)}`;
  if (block instanceof Api.PageBlockAuthorDate) {
    const author = renderRichText(block.author);
    const date = block.publishedDate > 0 ? new Date(block.publishedDate * 1000).toISOString().slice(0, 10) : '';
    return [author, date].filter(Boolean).join(' · ');
  }
  if (block instanceof Api.PageBlockHeader) return `## ${renderRichText(block.text)}`;
  if (block instanceof Api.PageBlockSubheader) return `### ${renderRichText(block.text)}`;
  if (block instanceof Api.PageBlockParagraph) return renderRichText(block.text);
  if (block instanceof Api.PageBlockPreformatted) {
    const content = richTextToPlainText(block.text);
    const fence = content.includes('```') ? '````' : '```';
    return `${fence}${block.language}\n${content}\n${fence}`;
  }
  if (block instanceof Api.PageBlockFooter) return `_${renderRichText(block.text)}_`;
  if (block instanceof Api.PageBlockDivider) return '---';
  if (block instanceof Api.PageBlockAnchor) return '';
  if (block instanceof Api.PageBlockList) return renderUnorderedList(block.items, state);
  if (block instanceof Api.PageBlockOrderedList) return renderOrderedList(block.items, state);
  if (block instanceof Api.PageBlockBlockquote || block instanceof Api.PageBlockPullquote) {
    const body = renderRichText(block.text);
    const caption = renderRichText(block.caption);
    return indent([body, caption && `— ${caption}`].filter(Boolean).join('\n'), '> ');
  }
  if (block instanceof Api.PageBlockPhoto)
    return renderPhoto(block.photoId.toString(), captionText(block.caption), state);
  if (block instanceof Api.PageBlockVideo)
    return [captionText(block.caption), `[Video ${block.videoId.toString()}]`].filter(Boolean).join('\n');
  if (block instanceof Api.PageBlockAudio)
    return [captionText(block.caption), `[Audio ${block.audioId.toString()}]`].filter(Boolean).join('\n');
  if (block instanceof Api.PageBlockCover) return renderBlock(block.cover, state);
  if (block instanceof Api.PageBlockEmbed) {
    const poster = block.posterPhotoId
      ? renderPhoto(block.posterPhotoId.toString(), 'Embed poster', state)
      : '';
    const link = block.url ? `[Embedded content](<${escapeLinkDestination(block.url)}>)` : '[Embedded content]';
    return [poster, link, captionText(block.caption)].filter(Boolean).join('\n');
  }
  if (block instanceof Api.PageBlockEmbedPost) {
    const header = `[Embedded post by ${escapeText(block.author)}](<${escapeLinkDestination(block.url)}>)`;
    return [header, renderBlocks(block.blocks, state), captionText(block.caption)].filter(Boolean).join('\n\n');
  }
  if (block instanceof Api.PageBlockCollage || block instanceof Api.PageBlockSlideshow)
    return [renderBlocks(block.items, state), captionText(block.caption)].filter(Boolean).join('\n\n');
  if (block instanceof Api.PageBlockChannel) {
    const channel = block.channel;
    return 'title' in channel ? `Channel: ${escapeText(channel.title)}` : '[Telegram channel]';
  }
  if (block instanceof Api.PageBlockKicker) return `**${renderRichText(block.text)}**`;
  if (block instanceof Api.PageBlockTable) return renderTable(block);
  if (block instanceof Api.PageBlockDetails)
    return [`**${renderRichText(block.title)}**`, renderBlocks(block.blocks, state)].filter(Boolean).join('\n\n');
  if (block instanceof Api.PageBlockRelatedArticles) {
    const articles = block.articles.map(article => {
      const label = escapeText(article.title ?? article.description ?? article.url);
      return `- [${label}](<${escapeLinkDestination(article.url)}>)`;
    }).join('\n');
    return [`## ${renderRichText(block.title)}`, articles].filter(Boolean).join('\n\n');
  }
  if (block instanceof Api.PageBlockMap) {
    const caption = captionText(block.caption);
    if (!(block.geo instanceof Api.GeoPoint)) return [caption, '[Map]'].filter(Boolean).join('\n');
    const mapUrl = `https://www.openstreetmap.org/?mlat=${block.geo.lat}&mlon=${block.geo.long}#map=${block.zoom}/${block.geo.lat}/${block.geo.long}`;
    return [caption, `[Map: ${block.geo.lat}, ${block.geo.long}](<${mapUrl}>)`].filter(Boolean).join('\n');
  }
  if (block instanceof Api.PageBlockUnsupported) return '[Unsupported Instant View block]';
  return '[Unsupported Instant View block]';
};

export const renderInstantViewMarkdown = (page: Api.Page, pageUrl: string): InstantViewMarkdownResult => {
  const state: RenderState = {
    pageUrl,
    photoIds: new Set(page.photos
      .filter((photo): photo is Api.Photo => photo instanceof Api.Photo)
      .map(photo => photo.id.toString())),
    hasPhotos: false,
  };
  const body = renderBlocks(page.blocks, state).trim();
  const comment = state.hasPhotos
    ? '<!-- Rendered from InstantView; use read_image with a telegram:// URL below to view photos. -->'
    : '<!-- Rendered from InstantView -->';
  return { content: `${comment}\n\n${body}`, hasPhotos: state.hasPhotos };
};
