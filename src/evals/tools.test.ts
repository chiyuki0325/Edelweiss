import { describe, expect, it } from 'vitest';

import { createEvalTools } from './tools';
import { executeToolCall } from '../driver/tools';

const log = { withFields: () => log, withError: () => log, error: () => {}, log: () => {} } as any;

describe('createEvalTools', () => {
  it('captures send_message without platform side effects', async () => {
    const { tools, trace } = createEvalTools();
    const result = await executeToolCall(
      'tc1',
      'send_message',
      JSON.stringify({ text: 'hello', await_response: false }),
      tools,
      log,
    );

    expect(JSON.parse(result.payload as string)).toEqual({ ok: true, message_id: 'eval-1' });
    expect(result.requiresFollowUp).toBe(false);
    expect(trace.sentMessages).toHaveLength(1);
    expect(trace.sentMessages[0]!.messageId).toBe('eval-1');
    expect(trace.sentMessages[0]!.text.trim()).toBe('hello');
  });

  it('omits load_skill when no skills folder is configured', () => {
    const { tools } = createEvalTools();
    expect(tools.map(t => t.function.name)).toEqual(['send_message', 'dismiss_message']);
  });

  it('prevents duplicate load_skill calls during one eval run', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const skillsFolder = mkdtempSync(join(tmpdir(), 'cahciua-eval-skills-'));
    writeFileSync(join(skillsFolder, 'debug.md'), '# Debug Skill\n\nUse for debugging.');

    const { tools, trace } = createEvalTools({ skillsFolder });
    const first = await executeToolCall(
      'tc1',
      'load_skill',
      JSON.stringify({ skill_name: 'debug' }),
      tools,
      log,
    );
    const second = await executeToolCall(
      'tc2',
      'load_skill',
      JSON.stringify({ skill_name: 'debug' }),
      tools,
      log,
    );

    expect(first.payload).toContain('# Debug Skill');
    expect(JSON.parse(second.payload as string)).toEqual({
      error: 'Skill "debug" is already loaded in the current context window.',
    });
    expect(trace.loadedSkills).toEqual(['debug']);
  });
});
