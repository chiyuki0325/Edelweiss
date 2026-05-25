/**
 * Dump a Telegram custom emoji through the same fetch/frame path used by
 * custom-emoji-to-text, without calling the description model.
 *
 * Usage:
 *   pnpm tsx scripts/dump-custom-emoji.ts 6280705808527267677
 *   OUT_DIR=/tmp/emoji pnpm tsx scripts/dump-custom-emoji.ts 6280705808527267677
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { useGlobalLogger, useLogger } from '@guiiai/logg';
import { Bot } from 'grammy';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';

import { httpGetBuffer, registerHttpSecret } from '../src/http';
import { renderCustomEmojiToTextSystemPrompt } from '../src/telegram/custom-emoji-to-text-prompt';
import { deduplicateFrames, extractFrames } from '../src/telegram/frame-extractor';
import { callDescriptionLlm } from '../src/telegram/llm-description';
import type { Attachment } from '../src/telegram/message/types';

const id = process.argv[2];
if (!id) {
  console.error('Usage: pnpm tsx scripts/dump-custom-emoji.ts <customEmojiId>');
  process.exit(1);
}

const configPath = process.env.CONFIG_PATH ?? 'config.yaml';
const config = parseYaml(await BunFileText(configPath));
const token = config?.telegram?.botToken;
if (!token) throw new Error(`telegram.botToken not found in ${configPath}`);
registerHttpSecret(token);

const outBase = process.env.OUT_DIR ?? join('data', 'custom-emoji-dumps');
const outDir = join(outBase, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(outDir, { recursive: true });

const bot = new Bot(token);
const stickers = await bot.api.getCustomEmojiStickers([id]);
const sticker = stickers[0];
if (!sticker) throw new Error(`getCustomEmojiStickers returned no sticker for ${id}`);
if (sticker.custom_emoji_id !== id)
  throw new Error(`Telegram returned mismatched custom_emoji_id: requested=${id}, got=${sticker.custom_emoji_id}`);

const file = await bot.api.getFile(sticker.file_id);
const filePath = file.file_path;
if (!filePath) throw new Error('Telegram getFile returned no file_path');

const sourceBuffer = await httpGetBuffer(`https://api.telegram.org/file/bot${token}/${filePath}`);
const sourceExt = extname(filePath) || '.bin';
const sourceName = `source${sourceExt}`;
await writeFile(join(outDir, sourceName), sourceBuffer);

const metadata = {
  requestedId: id,
  apiCustomEmojiId: sticker.custom_emoji_id,
  fallbackEmoji: sticker.emoji,
  setName: sticker.set_name,
  isAnimated: sticker.is_animated,
  isVideo: sticker.is_video,
  type: sticker.type,
  width: sticker.width,
  height: sticker.height,
  fileUniqueId: sticker.file_unique_id,
  fileSize: sticker.file_size,
  filePathBasename: basename(filePath),
  sourceBytes: sourceBuffer.length,
  sourceFile: sourceName,
};
await writeFile(join(outDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);

let llmImages: Array<{ url: string }>;
let isAnimatedForPrompt = sticker.is_animated || sticker.is_video;
let frameCount: number | undefined;
let frameTimestamps: string | undefined;

if (sticker.is_animated || sticker.is_video) {
  const syntheticAtt: Attachment = {
    type: 'sticker',
    isAnimatedSticker: sticker.is_animated,
    isVideoSticker: sticker.is_video,
  };
  const result = await extractFrames(sourceBuffer, syntheticAtt, Number(process.env.MAX_FRAMES ?? 5));
  const uniqueFrames = deduplicateFrames(result.frames);
  if (uniqueFrames.length === 1) isAnimatedForPrompt = false;
  llmImages = await Promise.all(uniqueFrames.map(async buf => ({ url: await prepareDataUrl(buf) })));
  frameCount = uniqueFrames.length;
  frameTimestamps = result.frameTimestamps
    ? result.frameTimestamps.map(t => `${t.toFixed(1)}s`).join(', ')
    : undefined;
  for (const [index, frame] of result.frames.entries())
    await writeFile(join(outDir, `extracted-frame-${String(index).padStart(2, '0')}.png`), frame);
  for (const [index, frame] of uniqueFrames.entries())
    await writeFile(join(outDir, `llm-frame-${String(index).padStart(2, '0')}.png`), frame);
  await writeFile(join(outDir, 'frames.json'), `${JSON.stringify({
    cacheKey: result.cacheKey,
    extractedFrames: result.frames.length,
    llmFramesAfterDedup: uniqueFrames.length,
    frameTimestamps: result.frameTimestamps,
  }, null, 2)}\n`);
} else {
  const png = await sharp(sourceBuffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  await writeFile(join(outDir, 'llm-static.png'), png);
  llmImages = [{ url: await prepareDataUrl(png) }];
}

if (process.env.DESCRIBE === '1') {
  useGlobalLogger({ level: 'verbose', mode: 'pretty' });
  const modelName = config.chats?.default?.customEmojiToText?.model;
  const model = modelName ? config.models?.[modelName] : undefined;
  if (!modelName || !model) throw new Error('chats.default.customEmojiToText.model is not configured');

  const fallbackEmoji = process.env.FALLBACK ?? sticker.emoji ?? '';
  const system = await renderCustomEmojiToTextSystemPrompt({
    fallbackEmoji,
    stickerSetName: process.env.STICKER_SET_NAME ?? sticker.set_name,
    isAnimated: isAnimatedForPrompt,
    frameCount,
    frameTimestamps,
  });
  await writeFile(join(outDir, 'describe-system-prompt.md'), system);

  const result = await callDescriptionLlm({
    model: { ...model, apiFormat: model.apiFormat ?? 'openai-chat' },
    system,
    userText: process.env.USER_TEXT ?? 'Describe this custom emoji.',
    images: llmImages,
    log: useLogger('dump-custom-emoji'),
    label: 'dump-custom-emoji',
  });
  await writeFile(join(outDir, 'describe-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`description: ${result.text}`);
  console.log(`description result: ${join(outDir, 'describe-result.json')}`);
}

console.log(`dumped custom emoji ${id}`);
console.log(`output: ${outDir}`);
console.log(`api emoji: ${sticker.emoji}`);
console.log(`api set_name: ${sticker.set_name ?? ''}`);
console.log(`open: ${join(outDir, sticker.is_animated || sticker.is_video ? 'llm-frame-00.png' : 'llm-static.png')}`);

async function BunFileText(path: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.readFile(path, 'utf-8'));
}

async function prepareDataUrl(buffer: Buffer): Promise<string> {
  const png = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
