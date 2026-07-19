import { execFile } from 'node:child_process';

import type { CahciuaTool, ToolResult } from './types';
import { createTool } from './types';
import type { RuntimeConfig } from '../../config/config';

const DOWNLOAD_TIMEOUT_MS = 60_000;

export const createDownloadFileTool = (deps: {
  downloadAttachment: (fileId: string) => Promise<Buffer>;
  runtime: RuntimeConfig;
}): CahciuaTool => createTool({
  name: 'download_file',
  execution: { lane: 'writer' },
  description: 'Download a file attachment from the chat to a local path. Use the file-id attribute from attachment elements in the chat context.',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The file-id attribute from an attachment element (format: messageId:index).' },
      path: { type: 'string', description: 'Destination file path in the workspace.' },
    },
    required: ['file_id', 'path'],
  },
  execute: async input => {
    const { file_id, path } = input as { file_id: string; path: string };

    let buffer: Buffer;
    try {
      buffer = await deps.downloadAttachment(file_id);
    } catch (err) {
      return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true };
    }

    if (buffer.length > deps.runtime.writeFileSizeLimit) {
      return {
        content: JSON.stringify({ error: `File too large: ${buffer.length} bytes exceeds limit of ${deps.runtime.writeFileSizeLimit} bytes.` }),
        requiresFollowUp: true,
      };
    }

    const writeCmd = deps.runtime.writeFile;
    return await new Promise<ToolResult>(resolve => {
      const child = execFile(
        writeCmd[0]!,
        [...writeCmd.slice(1), path],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            resolve({
              content: JSON.stringify({ error: `Failed to write file: ${stderr || error.message}` }),
              requiresFollowUp: true,
            });
          } else {
            resolve({
              content: JSON.stringify({ ok: true, path, size: buffer!.length }),
              requiresFollowUp: true,
            });
          }
        },
      );
      child.stdin?.end(buffer);
    });
  },
});
