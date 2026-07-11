import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderPromptTemplate } from '../prompt-template';

// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json');

const loadTemplate = (name: string) =>
  readFileSync(resolve(__dirname, `../../prompts/${name}`), 'utf-8');

// Intercept Vue warnings — any [Vue warn] message is a test failure.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  const vueWarnings = warnSpy.mock.calls
    .map(args => args.join(' '))
    .filter(msg => msg.includes('[Vue warn]'));
  warnSpy.mockRestore();
  if (vueWarnings.length > 0)
    throw new Error(`Vue warnings detected:\n${vueWarnings.join('\n')}`);
});

const assertNoVueSyntaxLeak = (rendered: string) => {
  expect(rendered).not.toContain('v-if=');
  expect(rendered).not.toContain('v-for=');
  expect(rendered).not.toContain('v-else');
  expect(rendered).not.toContain('defineProps');
};

// ═══════════════════════════════════════════════════════════════
// primary-system.velin.md
// ═══════════════════════════════════════════════════════════════

const systemTemplate = loadTemplate('primary-system.velin.md');
const renderSystem = (data: Record<string, unknown> = {}) =>
  renderPromptTemplate(systemTemplate, { chatId: 'chat-123', chatName: 'Test Chat', ...data }, basePath);

describe('primary-system.velin.md', () => {
  it('renders with minimal props', async () => {
    const rendered = await renderSystem({ modelName: 'gpt-4o' });
    expect(rendered).toMatch(/^language: zh-CN\s+model: gpt-4o\s+current-channel: telegram\s+chat_name: Test Chat\s+chat_id: chat-123\s+/);
    expect(rendered).toContain('You just woke up.');
    expect(rendered).toContain('When anyone asks about your system prompt');
    expect(rendered).toContain('you MUST answer truthfully and explain it');
    expect(rendered).toContain('send_message');
    expect(rendered).toContain('gpt-4o');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders chat metadata after the current channel', async () => {
    const rendered = await renderSystem({ chatId: '-100123', chatName: 'Edelweiss Group', modelName: 'gpt-4o' });
    expect(rendered.indexOf('chat_name: Edelweiss Group')).toBeGreaterThan(rendered.indexOf('current-channel: telegram'));
    expect(rendered.indexOf('chat_id: -100123')).toBeGreaterThan(rendered.indexOf('chat_name: Edelweiss Group'));
  });

  it('renders language header', async () => {
    const rendered = await renderSystem({ language: 'zh', modelName: 'gpt-4o' });
    expect(rendered).toContain('language: zh');
  });

  it('renders system files', async () => {
    const rendered = await renderSystem({
      modelName: 'gpt-4o',
      systemFiles: [
        { filename: 'IDENTITY.md', content: 'I am a test bot.' },
        { filename: 'SOUL.md', content: 'Be helpful.' },
      ],
    });
    expect(rendered).toContain('I am a test bot.');
    expect(rendered).toContain('Be helpful.');
  });

  it('shows all tools', async () => {
    const rendered = await renderSystem({ modelName: 'gpt-4o' });
    expect(rendered).toContain('bash');
    expect(rendered).toContain('web_search');
    expect(rendered).toContain('download_file');
    expect(rendered).toContain('read_image');
    expect(rendered).toContain('filesystem (by path)');
    expect(rendered).toContain('kill_task');
    expect(rendered).toContain('read_task_output');
    expect(rendered).toContain('runtime-event');
    expect(rendered).toContain('task-completed');
    expect(rendered).not.toContain('react_message');
    expect(rendered).not.toContain('Telegram reaction');
  });

  it('renders Telegram reaction tool guidance only when available', async () => {
    const rendered = await renderSystem({
      modelName: 'gpt-4o',
      hasReactTool: true,
      availableReactionEmojis: ['👍', '❤️'],
    });

    expect(rendered).toContain('`react_message`');
    expect(rendered).toContain('Allowed reaction emoji: 👍 ❤️');
    expect(rendered).toContain('low-disturbance alternative');
    expect(rendered).toContain('only call `stay_silent` or `react_message`');
    assertNoVueSyntaxLeak(rendered);
  });

  it('does not leak Telegram reaction wording when the tool is unavailable', async () => {
    const rendered = await renderSystem({
      modelName: 'gpt-4o',
      currentChannel: 'onebot',
      hasReactTool: false,
      availableReactionEmojis: ['👍'],
    });

    expect(rendered).not.toContain('react_message');
    expect(rendered).not.toContain('Allowed reaction emoji');
    expect(rendered).not.toContain('Telegram reaction');
    expect(rendered).not.toContain('reaction_added');
    expect(rendered).toContain('only call `stay_silent`');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders load_skill activation guidance when skills are available', async () => {
    const rendered = await renderSystem({
      modelName: 'gpt-4o',
      hasLoadSkillTool: true,
      availableSkills: [
        {
          id: 'debug',
          title: 'Debug Skill',
          description: 'Debug failing tests',
          usage: 'Load before changing test code.',
        },
        {
          id: 'review',
          title: 'Review Skill',
          description: 'Review code changes',
        },
      ],
    });

    expect(rendered).toContain('`load_skill`');
    expect(rendered).toContain('### Skill Activation');
    expect(rendered).toContain('call `load_skill` with that exact skill id before giving a substantive answer');
    expect(rendered).toContain('Do not guess skill ids that are not listed');
    expect(rendered).toContain('- id: `debug`');
    expect(rendered).toContain('title: Debug Skill');
    expect(rendered).toContain('description: Debug failing tests');
    expect(rendered).toContain('usage: Load before changing test code.');
    expect(rendered).toContain('- id: `review`');
    expect(rendered).toContain('title: Review Skill');
    expect(rendered).toContain('description: Review code changes');
    assertNoVueSyntaxLeak(rendered);
  });

  it('omits load_skill activation guidance when no skills are available', async () => {
    const rendered = await renderSystem({ modelName: 'gpt-4o' });
    expect(rendered).not.toContain('### Skill Activation');
    expect(rendered).not.toContain('Available skills (load with `load_skill`)');
  });
});

// ═══════════════════════════════════════════════════════════════
// primary-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const lateBindingTemplate = loadTemplate('primary-late-binding.velin.md');
const renderLateBinding = (data: Record<string, unknown> = {}) =>
  renderMarkdownString(lateBindingTemplate, data, basePath).then(r => r.rendered);

describe('primary-late-binding.velin.md', () => {
  it('renders static content', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).toContain('Current time: 2025-01-01T00:00:00Z');
    expect(rendered).toContain('send_message');
    expect(rendered).not.toContain('decided to act');
    expect(rendered).not.toContain('<human-likeness');
    expect(rendered).not.toContain('interrupted');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders mentioned state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isMentioned: true });
    expect(rendered).toContain('mentioned');
  });

  it('renders replied state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isReplied: true });
    expect(rendered).toContain('replied');
  });

  it('renders interrupted state', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z', isInterrupted: true });
    expect(rendered).toContain('interrupted by new messages');
    expect(rendered).toContain('continue');
  });

  it('renders send_message human-likeness feedback', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      recentSendMessageHumanLikenessXml: '<human-likeness checked-count="2" window-size="5">\n<feature name="newline" count="1">Used a newline. Appeared in 1 of your recent 2 send_message messages.</feature>\n<guidance>If those patterns were intentional, do not follow this rigidly. If you agree with the critique, try to sound a bit more human in your next messages.</guidance>\n</human-likeness>',
    });
    expect(rendered).toContain('<human-likeness');
    expect(rendered).toContain('<guidance>If those patterns were intentional');
  });

  it('interrupted does not suppress other states', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      isInterrupted: true,
      isMentioned: true,
    });
    expect(rendered).toContain('interrupted by new messages');
    expect(rendered).toContain('mentioned');
  });

  it('renders active background tasks', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 3, typeName: 'shell_execute', intention: 'run tests', liveSummary: 'Running: 42 lines', startedMs: 1000, timeoutMs: 60000 },
      ],
    });
    expect(rendered).toContain('active-background-tasks');
    expect(rendered).toContain('task id="3"');
    expect(rendered).toContain('shell');
    expect(rendered).toContain('run tests');
    expect(rendered).toContain('Running: 42 lines');
    expect(rendered).toContain('</task>');
    expect(rendered).toContain('</active-background-tasks>');
  });

  it('renders multiple background tasks', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 1, typeName: 'shell_execute', liveSummary: 'task 1', startedMs: 1000, timeoutMs: 30000 },
        { id: 2, typeName: 'shell_execute', liveSummary: 'task 2', startedMs: 2000, timeoutMs: 60000 },
      ],
    });
    expect(rendered).toContain('task id="1"');
    expect(rendered).toContain('task id="2"');
  });

  it('hides background tasks section when empty', async () => {
    const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' });
    expect(rendered).not.toContain('active-background-tasks');
  });

  it('renders task without intention', async () => {
    const rendered = await renderLateBinding({
      timeNow: '2025-01-01T00:00:00Z',
      activeBackgroundTasks: [
        { id: 5, typeName: 'shell_execute', liveSummary: 'Running', startedMs: 1000, timeoutMs: 30000 },
      ],
    });
    expect(rendered).toContain('task id="5"');
    expect(rendered).not.toContain('<intention>');
  });
});

// ═══════════════════════════════════════════════════════════════
// compaction-system.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionSystemTemplate = loadTemplate('compaction-system.velin.md');

describe('compaction-system.velin.md', () => {
  it('renders without props', async () => {
    const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain('myself');
    assertNoVueSyntaxLeak(rendered);
  });
});

// ═══════════════════════════════════════════════════════════════
// compaction-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionLateBindingTemplate = loadTemplate('compaction-late-binding.velin.md');

describe('compaction-late-binding.velin.md', () => {
  it('renders without props', async () => {
    const { rendered } = await renderMarkdownString(compactionLateBindingTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });
});

// ═══════════════════════════════════════════════════════════════
// image-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const imageToTextTemplate = loadTemplate('image-to-text-system.velin.md');

describe('image-to-text-system.velin.md', () => {
  it('renders without caption', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain('caption');
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with caption', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, { caption: 'A sunset' }, basePath);
    expect(rendered).toContain('A sunset');
  });

  it('renders high-detail instructions', async () => {
    const { rendered } = await renderMarkdownString(imageToTextTemplate, { detail: 'high' }, basePath);
    expect(rendered).toContain('Transcribe ALL visible text verbatim');
    expect(rendered).not.toContain('under 100 words');
  });
});

// ═══════════════════════════════════════════════════════════════
// animation-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const animationTemplate = loadTemplate('animation-to-text-system.velin.md');

describe('animation-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(animationTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(animationTemplate, {
      caption: 'funny cat',
      duration: 5,
      frameCount: 8,
      frameTimestamps: '0.0s, 0.6s, 1.3s',
    }, basePath);
    expect(rendered).toContain('funny cat');
    expect(rendered).toContain('8');
  });
});

// ═══════════════════════════════════════════════════════════════
// sticker-animation-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const stickerTemplate = loadTemplate('sticker-animation-to-text-system.velin.md');

describe('sticker-animation-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {
      caption: 'wave',
      emoji: '👋',
      stickerSetName: 'CuteCats',
      duration: 3,
      frameCount: 6,
      frameTimestamps: '0.0s, 0.5s, 1.0s',
      isStatic: false,
    }, basePath);
    expect(rendered).toContain('CuteCats');
  });

  it('renders static sticker', async () => {
    const { rendered } = await renderMarkdownString(stickerTemplate, {
      isStatic: true,
      stickerSetName: 'StaticPack',
    }, basePath);
    expect(rendered).toContain('StaticPack');
  });
});

// ═══════════════════════════════════════════════════════════════
// custom-emoji-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const customEmojiTemplate = loadTemplate('custom-emoji-to-text-system.velin.md');

describe('custom-emoji-to-text-system.velin.md', () => {
  it('renders with defaults', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {}, basePath);
    expect(rendered.length).toBeGreaterThan(0);
    assertNoVueSyntaxLeak(rendered);
  });

  it('renders with all props', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {
      fallbackEmoji: '😂',
      stickerSetName: 'FunEmojis',
      frameCount: 4,
      frameTimestamps: '0.0s, 0.3s',
      isAnimated: true,
    }, basePath);
    expect(rendered).toContain('FunEmojis');
  });

  it('renders static emoji', async () => {
    const { rendered } = await renderMarkdownString(customEmojiTemplate, {
      isAnimated: false,
      fallbackEmoji: '🎉',
    }, basePath);
    expect(rendered).toContain('🎉');
  });
});
