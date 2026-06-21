import { describe, expect, it, vi } from 'vitest';

import { createBashTool, createLoadSkillTool, createReactMessageTool, createReadImageTool, createSendMessageTool, createTool, executeToolCall, extractLoadedSkillNames } from './tools';
import type { SendMessageTurnFlags } from './tools';
import type { RuntimeConfig } from '../config/config';
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

const runtime: RuntimeConfig = {
  shell: ['sh', '-c'],
  writeFile: ['tee'],
  readFile: ['cat'],
  writeFileSizeLimit: 1024,
  readFileSizeLimit: 1024,
};

describe('createBashTool', () => {
  it('intercepts pseudo commands before background task execution', async () => {
    const startTask = vi.fn();
    const tool = createBashTool(runtime, {
      startTask,
      sessionId: 'chat-1',
      backgroundThresholdSec: 5,
      compactOutput: false,
      pseudoCommands: {
        chatId: 'chat-1',
        currentChannel: 'telegram',
        skillsFolder: '/repo/skills',
        skills: new Map(),
      },
    });

    const result = await tool.execute({
      command: 'chat_info',
      timeout_seconds: 60,
    }, { toolCallId: 'tc1' });

    expect(startTask).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string)).toEqual({
      exit_code: 0,
      output: `${JSON.stringify({
        chatId: 'chat-1',
        currentChannel: 'telegram',
        skillsFolder: '/repo/skills',
      }, null, 2)}\n`,
      truncated: false,
    });
  });
});

describe('createReactMessageTool', () => {
  it('sends an allowed reaction without requesting follow-up', async () => {
    const react = vi.fn(async () => {});
    const tool = createReactMessageTool(['👍'], react);

    const params = tool.function.parameters as { properties: { emoji: { enum: string[] } } };
    expect(params.properties.emoji.enum).toEqual(['👍']);

    const result = await tool.execute({ message_id: '42', emoji: '👍' }, { toolCallId: 'tc1' });
    expect(react).toHaveBeenCalledWith('42', '👍');
    expect(JSON.parse(result.content as string)).toEqual({ ok: true, message_id: '42', emoji: '👍' });
    expect(result.requiresFollowUp).toBe(false);
  });

  it('rejects a disallowed reaction emoji', async () => {
    const react = vi.fn(async () => {});
    const tool = createReactMessageTool(['👍'], react);

    const result = await tool.execute({ message_id: '42', emoji: '❤️' }, { toolCallId: 'tc1' });
    expect(react).not.toHaveBeenCalled();
    expect(JSON.parse(result.content as string).error).toContain('not allowed');
    expect(result.requiresFollowUp).toBe(true);
  });
});

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
    ['debug', { name: 'debug', description: 'Debug Skill', format: 'custom' as const, content: 'Find the failing path.' }],
    ['music', {
      name: 'music',
      title: 'Music Helper',
      description: 'Use for music search.',
      usage: 'Load before answering music requests.',
      format: 'custom-v2' as const,
      content: 'Follow the music workflow.',
    }],
    ['browser-use', {
      name: 'browser-use',
      description: 'Use for browser automation.',
      format: 'anthropic' as const,
      content: 'Inspect pages carefully.',
      resourceFiles: ['README.md', 'scripts/open.ts'],
    }],
  ]);

  it('rejects skills already loaded in the current context window', async () => {
    const loaded = new Set(['debug']);
    const tool = createLoadSkillTool(
      () => skills,
      name => { loaded.add(name); },
      name => loaded.has(name),
    );

    const result = await tool.execute({ skill_id: 'debug' }, { toolCallId: 'tc1' });

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

    const first = await tool.execute({ skill_id: 'debug' }, { toolCallId: 'tc1' });
    const second = await tool.execute({ skill_id: 'debug' }, { toolCallId: 'tc2' });

    expect(first.content).toContain('# debug');
    expect(first.content).toContain('## Description\n\nDebug Skill');
    expect(loaded.has('debug')).toBe(true);
    expect(second).toEqual({
      content: JSON.stringify({ error: 'Skill "debug" is already loaded in the current context window.' }),
      requiresFollowUp: true,
    });
  });

  it('formats front-matter skill metadata without using display name as lookup id', async () => {
    const tool = createLoadSkillTool(
      () => skills,
      () => {},
    );

    const result = await tool.execute({ skill_id: 'music' }, { toolCallId: 'tc1' });

    expect(result.content).toContain('# Music Helper');
    expect(result.content).toContain('## Description\n\nUse for music search.');
    expect(result.content).toContain('## Usage\n\nLoad before answering music requests.');
    expect(result.content).toContain('Follow the music workflow.');
  });

  it('lists anthropic resource files without embedding their contents', async () => {
    const tool = createLoadSkillTool(
      () => skills,
      () => {},
    );

    const result = await tool.execute({ skill_id: 'browser-use' }, { toolCallId: 'tc1' });

    expect(result.content).toContain('# browser-use');
    expect(result.content).toContain('## Resource files\n\n- README.md\n- scripts/open.ts');
    expect(result.content).not.toContain('console.log');
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
            args: JSON.stringify({ skill_id: 'debug' }),
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
            args: JSON.stringify({ skill_id: 'debug' }),
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

describe('createSendMessageTool', () => {
  const makeText = (len: number) => 'x'.repeat(len);

  it('returns error and sets wasLengthLimited when message exceeds 256 bytes', async () => {
    const send = vi.fn();
    const flags: SendMessageTurnFlags = { wasLengthLimited: false };
    const tool = createSendMessageTool(send, flags);

    const longText = makeText(257);
    const result = await tool.execute({ text: longText }, { toolCallId: 'tc1' });

    expect(flags.wasLengthLimited).toBe(true);
    expect(result.requiresFollowUp).toBe(true);
    const payload = JSON.parse(result.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('too long');
    expect(send).not.toHaveBeenCalled();
  });

  it('auto-overrides requiresFollowUp to true after wasLengthLimited was set', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const flags: SendMessageTurnFlags = { wasLengthLimited: true };
    const tool = createSendMessageTool(send, flags);

    // Model omits await_response — should auto-override to true
    const result = await tool.execute({ text: makeText(10) }, { toolCallId: 'tc2' });

    expect(result.requiresFollowUp).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('respects explicit await_response: false even after wasLengthLimited', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '43' });
    const flags: SendMessageTurnFlags = { wasLengthLimited: true };
    const tool = createSendMessageTool(send, flags);

    // Model explicitly signals "done" — should be respected
    const result = await tool.execute(
      { text: makeText(10), await_response: false },
      { toolCallId: 'tc3' },
    );

    expect(result.requiresFollowUp).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('requiresFollowUp defaults to false when wasLengthLimited is false and await_response is omitted', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '44' });
    const flags: SendMessageTurnFlags = { wasLengthLimited: false };
    const tool = createSendMessageTool(send, flags);

    const result = await tool.execute({ text: makeText(10) }, { toolCallId: 'tc4' });

    expect(result.requiresFollowUp).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
