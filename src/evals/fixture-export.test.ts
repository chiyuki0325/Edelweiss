import { describe, expect, it } from 'vitest';

import {
  buildEvalFixture,
  selectFixtureEvents,
  serializeEvalFixture,
} from './fixture-export';
import type { PipelineEvent } from '../projection';

const user = { id: 'u1', displayName: 'Alice', username: 'alice', isBot: false };

const message = (
  messageId: string,
  receivedAtMs: number,
  text: string,
  replyToMessageId?: string,
): PipelineEvent => ({
  type: 'message',
  chatId: 'chat',
  messageId,
  sender: user,
  receivedAtMs,
  timestampSec: Math.floor(receivedAtMs / 1000),
  utcOffsetMin: 480,
  content: [{ type: 'text', text }],
  attachments: [],
  ...(replyToMessageId ? { replyToMessageId } : {}),
});

const edit = (messageId: string, receivedAtMs: number, text: string): PipelineEvent => ({
  type: 'edit',
  chatId: 'chat',
  messageId,
  sender: user,
  receivedAtMs,
  timestampSec: Math.floor(receivedAtMs / 1000),
  utcOffsetMin: 480,
  content: [{ type: 'text', text }],
  attachments: [],
});

const service = (receivedAtMs: number): PipelineEvent => ({
  type: 'service',
  chatId: 'chat',
  receivedAtMs,
  timestampSec: Math.floor(receivedAtMs / 1000),
  utcOffsetMin: 480,
  action: {
    action: 'chat_renamed',
    newTitle: 'New Chat',
  },
});

describe('selectFixtureEvents', () => {
  it('selects all events in a message-id range time window', () => {
    const events = [
      message('1', 1000, 'one'),
      message('2', 2000, 'two'),
      service(2500),
      message('3', 3000, 'three'),
      message('4', 4000, 'four'),
    ];

    const selected = selectFixtureEvents(events, {
      type: 'messageRange',
      fromMessageId: '2',
      toMessageId: '3',
    });

    expect(selected.events.map(event => event.type)).toEqual(['message', 'service', 'message']);
    expect(selected.startMs).toBe(2000);
    expect(selected.endMs).toBe(3000);
  });

  it('selects explicit messages with reply closure and edits', () => {
    const events = [
      message('1', 1000, 'root'),
      message('2', 2000, 'reply', '1'),
      edit('2', 2500, 'reply edited'),
      message('3', 3000, 'next'),
    ];

    const selected = selectFixtureEvents(events, {
      type: 'messages',
      messageIds: ['2'],
      includeReplies: true,
    });

    expect(selected.events.map(event => eventMessageLabel(event))).toEqual([
      'message:1',
      'message:2',
      'edit:2',
    ]);
  });
});

describe('serializeEvalFixture', () => {
  it('serializes IC maps and optional turn responses', () => {
    const selected = selectFixtureEvents([message('1', 1000, 'hello')], {
      type: 'messages',
      messageIds: ['1'],
    });
    const fixture = buildEvalFixture('chat', selected, {
      name: 'sample',
      turnResponses: [{
        requestedAtMs: 1200,
        entries: [],
        inputTokens: 1,
        outputTokens: 2,
        modelName: 'model',
        agentId: 'main',
      }],
    });

    const source = serializeEvalFixture(fixture, '../../src/evals');
    expect(source).toContain("import type { EvalFixture } from '../../src/evals';");
    expect(source).toContain('new Map([');
    expect(source).toContain('"turnResponses"');
    expect(source).toContain('satisfies EvalFixture');
  });
});

const eventMessageLabel = (event: PipelineEvent): string => {
  if (event.type === 'message' || event.type === 'edit') return `${event.type}:${event.messageId}`;
  return event.type;
};
