import { renderMarkdownString } from '@velin-dev/core';

// Strip Vue SSR artifacts (fragment markers, v-if placeholders),
// restore newline placeholders from template computed properties,
// unescape Velin's markdown escaping, and normalize whitespace.
export const cleanVelinOutput = (raw: string): string =>
  raw
    .replace(/<!--\[-->/g, '')
    .replace(/<!--]-->/g, '')
    .replace(/<!--v-if-->/g, '')
    .replace(/<!---->/g, '')
    .replace(/\u200B/g, '\n')
    .replace(/\\`/g, '`')
    .replace(/\\_/g, '_')
    .replace(/^[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export interface PromptSystemFile {
  filename: string;
  content: string;
}

export const renderPromptTemplate = async (
  template: string,
  params: Record<string, unknown>,
  basePath: string,
): Promise<string> => {
  const publicParams = { ...params };
  const systemFiles = ((params.systemFiles as PromptSystemFile[] | undefined) ?? [])
    .map(f => ({ ...f }));

  for (const f of systemFiles) {
    if (!f.filename.endsWith('.velin.md')) continue;
    const rendered = await renderMarkdownString(f.content, publicParams, basePath);
    f.filename = f.filename.replace('.velin.md', '.md');
    f.content = cleanVelinOutput(rendered.rendered);
  }

  let { rendered } = await renderMarkdownString(template, { ...publicParams, systemFiles }, basePath);
  rendered = cleanVelinOutput(rendered);

  // Velin can collapse newlines inside interpolated markdown file bodies.
  // Templates can place SYSTEM_FILE_<filename> placeholders to preserve blocks.
  for (const f of systemFiles) {
    const placeholder = `SYSTEM_FILE_${f.filename}`;
    rendered = rendered.replaceAll(placeholder, f.content);
  }

  return rendered;
};
