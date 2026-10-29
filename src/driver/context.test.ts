import type { ToolMessage } from '@langchain/core/messages';
import { isAIMessage, isToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { composeContext, latestExternalEventMs, latestInterruptingExternalEventMs } from './context';
import {
  aiMessage,
  humanMessage,
  messageBlocks,
  messageText,
  toolMessage,
  type DriverInputBlock,
  type DriverMessage,
} from './messages';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';

const CURRENT_MODEL = 'test-model';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, entries: DriverMessage[], modelName = CURRENT_MODEL): TurnResponseV2 => ({
  requestedAtMs: ts,
  entries,
  inputTokens: 0,
  outputTokens: 0,
  modelName,
});

const assistantText = (text: string): DriverMessage => aiMessage(text);

const assistantToolCall = (callId: string, name = 'read'): DriverMessage =>
  aiMessage({ content: '', tool_calls: [{ id: callId, name, args: {} }] });

const toolResult = (callId: string, payload: string | DriverInputBlock[]): ToolMessage =>
  toolMessage(callId, payload, true);

const longText = (label: string): string => `${label}:${'x'.repeat(1000)}`;

const getToolResults = (entries: DriverMessage[]): ToolMessage[] =>
  entries.filter(isToolMessage);

describe('composeContext — trimToolResults', () => {
  it('keeps only the last 5 oversized tool results untrimmed', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 7 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    expect(tres).toHaveLength(7);
    expect(tres[0]!.content).toMatch(/\[trimmed/);
    expect(tres[1]!.content).toMatch(/\[trimmed/);
    for (let i = 2; i < 7; i++) expect(tres[i]!.content).toBe(contents[i]);
  });

  it('does nothing when there are exactly 5 oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 5 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    for (let i = 0; i < 5; i++) expect(tres[i]!.content).toBe(contents[i]);
  });

  it('trimmed content preserves head and tail', () => {
    const content = `HEAD${'x'.repeat(800)}TAIL`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [assistantToolCall('tc0'), toolResult('tc0', content)]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const trimmed = getToolResults(result!.entries)[0]!.content as string;
    expect(trimmed).toContain('HEAD');
    expect(trimmed).toContain('TAIL');
    expect(trimmed).toContain('[trimmed');
  });

  it('preserves assistant entries when trimming older oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [
        assistantToolCall('tc0'),
        toolResult('tc0', longText('oldest')),
        assistantText('I read the file'),
      ]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const entries = result!.entries;
    const tres = getToolResults(entries);
    expect(tres[0]!.content).toMatch(/\[trimmed/);
    const hasAssistantText = entries.some(entry =>
      isAIMessage(entry) && messageText(entry) === 'I read the file');
    expect(hasAssistantText).toBe(true);
  });
});

describe('composeContext — reasoning strip on model mismatch', () => {
  const reasoningEntry: DriverMessage = aiMessage({
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'answer' },
    ],
  });

  it('preserves reasoning when modelName matches current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], CURRENT_MODEL)];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(isAIMessage);
    expect(assistant).toBeDefined();
    const hasReasoning = messageBlocks(assistant!).some(block => block.type === 'thinking');
    expect(hasReasoning).toBe(true);
  });

  it('strips reasoning when modelName differs from current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], 'other-model')];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(isAIMessage);
    expect(assistant).toBeDefined();
    const hasReasoning = messageBlocks(assistant!).some(block => block.type === 'thinking');
    expect(hasReasoning).toBe(false);
  });
});

describe('composeContext — misc', () => {
  it('returns null when rc + trs + summary are all empty', () => {
    expect(composeContext([], [], 100_000, CURRENT_MODEL)).toBeNull();
  });

  it('prepends compact summary as first user message', () => {
    const result = composeContext([textSeg(100, 'hi')], [], 100_000, CURRENT_MODEL, 'earlier stuff');
    expect(result).not.toBeNull();
    const first = result!.entries[0]!;
    expect(first).toEqual(humanMessage(messageText(first)));
    const firstText = messageText(first);
    expect(firstText).toContain('Conversation summary');
    expect(firstText).toContain('earlier stuff');
  });
});

describe('event timestamp helpers', () => {
  it('counts runtime events as wake events but not interrupting external messages', () => {
    const rc: RenderedContext = [
      { ...textSeg(100, 'task done'), isRuntimeEvent: true },
    ];

    expect(latestExternalEventMs(rc, 50)).toBe(100);
    expect(latestInterruptingExternalEventMs(rc, 50)).toBeNull();
  });

  it('counts non-self chat segments as interrupting external messages', () => {
    const rc: RenderedContext = [
      textSeg(100, 'new user message'),
    ];

    expect(latestExternalEventMs(rc, 50)).toBe(100);
    expect(latestInterruptingExternalEventMs(rc, 50)).toBe(100);
  });

  it('ignores self messages for both wake and interrupt decisions', () => {
    const rc: RenderedContext = [
      { ...textSeg(100, 'bot message'), isMyself: true },
    ];

    expect(latestExternalEventMs(rc, 50)).toBeNull();
    expect(latestInterruptingExternalEventMs(rc, 50)).toBeNull();
  });

  it('ignores passive reaction events for both wake and interrupt decisions', () => {
    const rc: RenderedContext = [
      { ...textSeg(100, '<event type="reaction_added" message_id="1" emoji="👍"/>'), isPassiveEvent: true },
    ];

    expect(latestExternalEventMs(rc, 50)).toBeNull();
    expect(latestInterruptingExternalEventMs(rc, 50)).toBeNull();
  });
});
