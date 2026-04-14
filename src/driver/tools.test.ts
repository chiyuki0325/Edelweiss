import { describe, expect, it, vi } from 'vitest';

import { createReadImageTool } from './tools';

const createTinyPng = async (): Promise<Buffer> => {
  const { default: sharp } = await import('sharp');
  return await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
};

describe('createReadImageTool', () => {
  it('supports file-id-only mode when readFile is unavailable', async () => {
    const tinyPng = await createTinyPng();
    const downloadAttachment = vi.fn(async () => tinyPng);
    const resolveImageToText = vi.fn(async () => 'tiny image');
    const tool = createReadImageTool({ downloadAttachment, resolveImageToText });

    expect(tool.function.description).toContain('current conversation');
    expect((tool.function.parameters as any).properties.path).toBeUndefined();

    const result = await tool.execute({ file_id: '1:0' }, { toolCallId: 'tc1' });
    expect(downloadAttachment).toHaveBeenCalledWith('1:0');
    expect(resolveImageToText).toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, description: 'tiny image' }),
      requiresFollowUp: true,
    });
  });

  it('rejects filesystem paths when readFile is unavailable', async () => {
    const tool = createReadImageTool({
      downloadAttachment: async () => await createTinyPng(),
    });

    const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(result).toEqual({
      content: JSON.stringify({ error: 'This chat only supports read_image by file_id from the current conversation.' }),
      requiresFollowUp: true,
    });
  });

  it('adds filesystem path support when readFile is available', async () => {
    const tinyPng = await createTinyPng();
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({
      downloadAttachment: async () => { throw new Error('should not be called'); },
      readFile,
    });

    expect(tool.function.description).toContain('filesystem');
    expect((tool.function.parameters as any).properties.path).toMatchObject({ type: 'string' });

    const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(readFile).toHaveBeenCalledWith('/tmp/test.png');
    expect(result).toMatchObject({
      requiresFollowUp: true,
      content: [{ type: 'input_image', detail: 'low' }],
    });
  });
});
