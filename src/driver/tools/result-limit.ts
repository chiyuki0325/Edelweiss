import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CahciuaTool, CahciuaToolExecuteOptions, ToolResult } from './types';
import { redactSecrets } from '../../http';

export const TOOL_OUTPUT_MAX_LINES = 256;
export const TOOL_OUTPUT_MAX_BYTES = 10 * 1024;

const DEFAULT_TOOL_OUTPUT_DIR = join(tmpdir(), 'edelweiss-tool-output');

export interface ToolResultLimitOptions {
  maxLines?: number;
  maxBytes?: number;
  outputDir?: string;
}

const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
};

const sliceByBytes = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const slice = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return slice.endsWith('\uFFFD') ? slice.slice(0, -1) : slice;
};

const buildPreview = (content: string, maxLines: number, maxBytes: number): string => {
  const firstLines = content.split('\n', maxLines + 1).slice(0, maxLines).join('\n');
  return sliceByBytes(firstLines, maxBytes);
};

const writeFullOutput = async (toolName: string, content: string, outputDir: string): Promise<string> => {
  await mkdir(outputDir, { recursive: true });
  const safeName = toolName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
  const path = join(outputDir, `${safeName}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 });
  return path;
};

export const limitToolOutput = async (
  toolName: string,
  content: string,
  options: ToolResultLimitOptions = {},
): Promise<string> => {
  const maxLines = options.maxLines ?? TOOL_OUTPUT_MAX_LINES;
  const maxBytes = options.maxBytes ?? TOOL_OUTPUT_MAX_BYTES;
  const safeContent = redactSecrets(content);
  const originalBytes = Buffer.byteLength(safeContent, 'utf8');
  const originalLines = countLines(safeContent);
  if (originalBytes <= maxBytes && originalLines <= maxLines) return safeContent;

  const preview = buildPreview(safeContent, maxLines, maxBytes);
  let fullOutputPath: string | undefined;
  let writeError: string | undefined;
  try {
    fullOutputPath = await writeFullOutput(toolName, safeContent, options.outputDir ?? DEFAULT_TOOL_OUTPUT_DIR);
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
  }

  return JSON.stringify({
    truncated: true,
    tool: toolName,
    original_bytes: originalBytes,
    original_lines: originalLines,
    preview,
    ...(fullOutputPath ? { full_output_path: fullOutputPath } : {}),
    ...(writeError ? { full_output_error: writeError } : {}),
  });
};

/** Wrap a tool so oversized string results are written to a temp file and previewed. */
export const withToolResultLimit = (
  tool: CahciuaTool,
  options: ToolResultLimitOptions = {},
): CahciuaTool => ({
  ...tool,
  execute: async (input: unknown, execOptions: CahciuaToolExecuteOptions): Promise<ToolResult> => {
    const result = await tool.execute(input, execOptions);
    if (typeof result.content !== 'string') return result;
    const content = await limitToolOutput(tool.function.name, result.content, options);
    return content === result.content ? result : { ...result, content };
  },
});
