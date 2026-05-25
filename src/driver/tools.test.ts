import { describe, expect, it, vi } from 'vitest';

import { createLoadSkillTool, createReadImageTool, createTool, executeToolCall, extractLoadedSkillNames } from './tools';
import type { ConversationEntry } from '../unified-api/types';

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
  it('resolves image-to-text description via attachment file_id', async () => {
    const tinyPng = await createTinyPng();
    const downloadAttachment = vi.fn(async () => tinyPng);
    const resolveImageToText = vi.fn(async () => 'tiny image');
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({ downloadAttachment, readFile, resolveImageToText });

    expect(tool.function.description).toContain('filesystem');
    expect((tool.function.parameters as any).properties.path).toMatchObject({ type: 'string' });

    const result = await tool.execute({ file_id: '1:0' }, { toolCallId: 'tc1' });
    expect(downloadAttachment).toHaveBeenCalledWith('1:0');
    expect(resolveImageToText).toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ ok: true, description: 'tiny image' }),
      requiresFollowUp: true,
    });
  });

  it('rejects when both file_id and path are provided', async () => {
    const tool = createReadImageTool({
      downloadAttachment: async () => await createTinyPng(),
      readFile: async () => await createTinyPng(),
    });

    const result = await tool.execute({ file_id: '1:0', path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(result).toEqual({
      content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }),
      requiresFollowUp: true,
    });
  });

  it('reads image from filesystem path', async () => {
    const tinyPng = await createTinyPng();
    const readFile = vi.fn(async () => tinyPng);
    const tool = createReadImageTool({
      downloadAttachment: async () => { throw new Error('should not be called'); },
      readFile,
    });

    const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' });
    expect(readFile).toHaveBeenCalledWith('/tmp/test.png');
    expect(result).toMatchObject({
      requiresFollowUp: true,
      content: [{ kind: 'image', detail: 'low' }],
    });
  });
});

describe('createLoadSkillTool', () => {
  const skills = new Map([
    ['debug', { name: 'debug', title: 'Debug Skill', content: 'Find the failing path.' }],
  ]);

  it('rejects skills already loaded in the current context window', async () => {
    const loaded = new Set(['debug']);
    const tool = createLoadSkillTool(
      () => skills,
      name => { loaded.add(name); },
      name => loaded.has(name),
    );

    const result = await tool.execute({ skill_name: 'debug' }, { toolCallId: 'tc1' });

    expect(result).toEqual({
      content: JSON.stringify({ error: 'Skill "debug" is already loaded in the current context window.' }),
      requiresFollowUp: true,
    });
  });

  it('marks a skill loaded after successful execution', async () => {
    const loaded = new Set<string>();
    const tool = createLoadSkillTool(
      () => skills,
      name => { loaded.add(name); },
      name => loaded.has(name),
    );

    const first = await tool.execute({ skill_name: 'debug' }, { toolCallId: 'tc1' });
    const second = await tool.execute({ skill_name: 'debug' }, { toolCallId: 'tc2' });

    expect(first.content).toContain('# Debug Skill');
    expect(loaded.has('debug')).toBe(true);
    expect(second).toEqual({
      content: JSON.stringify({ error: 'Skill "debug" is already loaded in the current context window.' }),
      requiresFollowUp: true,
    });
  });
});

describe('extractLoadedSkillNames', () => {
  it('extracts successful load_skill calls from current context entries', () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'assistant',
        reasoning: undefined,
        parts: [
          {
            kind: 'toolCall',
            callId: 'tc1',
            name: 'load_skill',
            args: JSON.stringify({ skill_name: 'debug' }),
          },
        ],
      },
      {
        kind: 'toolResult',
        callId: 'tc1',
        payload: '# Debug Skill\n\nInstructions',
        requiresFollowUp: true,
      },
    ];

    expect([...extractLoadedSkillNames(entries)]).toEqual(['debug']);
  });

  it('ignores failed load_skill results', () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'assistant',
        reasoning: undefined,
        parts: [
          {
            kind: 'toolCall',
            callId: 'tc1',
            name: 'load_skill',
            args: JSON.stringify({ skill_name: 'debug' }),
          },
        ],
      },
      {
        kind: 'toolResult',
        callId: 'tc1',
        payload: JSON.stringify({ error: 'Skill "debug" is already loaded in the current context window.' }),
        requiresFollowUp: true,
      },
    ];

    expect([...extractLoadedSkillNames(entries)]).toEqual([]);
  });
});

describe('executeToolCall', () => {
  const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

  const greetTool = createTool({
    name: 'greet',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async input => {
      const { name } = input as { name: string };
      return { content: `hello ${name}`, requiresFollowUp: false };
    },
  });

  it('returns error for unknown tool', async () => {
    const result = await executeToolCall('id1', 'nonexistent', '{}', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('Unknown tool: nonexistent');
  });

  it('returns error for invalid JSON args', async () => {
    const result = await executeToolCall('id1', 'greet', '{not json', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('Invalid JSON');
    expect(payload.error).toContain('{not json');
  });

  it('returns error when args fail schema validation', async () => {
    const result = await executeToolCall('id1', 'greet', '{"age": 5}', [greetTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('do not match schema');
    expect(payload.error).toContain('name');
  });

  it('executes successfully with valid args', async () => {
    const result = await executeToolCall('id1', 'greet', '{"name": "world"}', [greetTool], log);
    expect(result.payload).toBe('hello world');
    expect(result.requiresFollowUp).toBe(false);
  });

  it('returns error when tool.execute throws', async () => {
    const throwingTool = createTool({
      name: 'greet',
      parameters: greetTool.function.parameters,
      execute: async () => { throw new Error('boom'); },
    });
    const result = await executeToolCall('id1', 'greet', '{"name": "x"}', [throwingTool], log);
    const payload = JSON.parse(result.payload as string);
    expect(payload.error).toContain('boom');
    expect(result.requiresFollowUp).toBe(true);
  });
});
