import { loadEvents, loadTurnResponses } from '../db';
import type { DB } from '../db';
import type { TurnResponseV2 } from '../driver/types';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import { rcToXml, render } from '../rendering';
import type { EvalFixture } from './types';

export type FixtureEventSelector =
  | {
    type: 'messageRange';
    fromMessageId: string;
    toMessageId: string;
  }
  | {
    type: 'receivedRange';
    fromMs: number;
    toMs: number;
  }
  | {
    type: 'messages';
    messageIds: string[];
    includeReplies?: boolean;
    contextBefore?: number;
    contextAfter?: number;
  };

export interface FixtureExportOptions {
  chatId: string;
  name?: string;
  selector: FixtureEventSelector;
  includeTurnResponses?: boolean;
  turnResponsesAgentId?: string;
  turnResponsesBeforeMs?: number;
  turnResponsesAfterMs?: number;
}

export interface SelectedFixtureEvents {
  events: PipelineEvent[];
  startMs: number;
  endMs: number;
}

const eventMessageIds = (event: PipelineEvent): string[] => {
  switch (event.type) {
  case 'message':
  case 'edit':
    return [event.messageId];
  case 'delete':
    return event.messageIds;
  default:
    return [];
  }
};

const messageIdNumber = (messageId: string): number | null => {
  const n = Number(messageId);
  return Number.isFinite(n) ? n : null;
};

const isMessageBetween = (messageId: string, from: string, to: string): boolean => {
  const currentNum = messageIdNumber(messageId);
  const fromNum = messageIdNumber(from);
  const toNum = messageIdNumber(to);
  if (currentNum != null && fromNum != null && toNum != null) {
    const min = Math.min(fromNum, toNum);
    const max = Math.max(fromNum, toNum);
    return currentNum >= min && currentNum <= max;
  }
  return messageId >= from && messageId <= to;
};

const selectedByTime = (events: PipelineEvent[], startMs: number, endMs: number): SelectedFixtureEvents => {
  const min = Math.min(startMs, endMs);
  const max = Math.max(startMs, endMs);
  const selected = events.filter(event => event.receivedAtMs >= min && event.receivedAtMs <= max);
  return {
    events: selected,
    startMs: selected[0]?.receivedAtMs ?? min,
    endMs: selected[selected.length - 1]?.receivedAtMs ?? max,
  };
};

const selectMessageRange = (
  events: PipelineEvent[],
  selector: Extract<FixtureEventSelector, { type: 'messageRange' }>,
): SelectedFixtureEvents => {
  const messages = events.filter(event =>
    event.type === 'message' && isMessageBetween(event.messageId, selector.fromMessageId, selector.toMessageId));
  if (messages.length === 0)
    throw new Error(`No message events found between ${selector.fromMessageId} and ${selector.toMessageId}`);

  return selectedByTime(events, messages[0]!.receivedAtMs, messages[messages.length - 1]!.receivedAtMs);
};

const selectExplicitMessages = (
  events: PipelineEvent[],
  selector: Extract<FixtureEventSelector, { type: 'messages' }>,
): SelectedFixtureEvents => {
  const messageEvents = events.filter((event): event is Extract<PipelineEvent, { type: 'message' }> =>
    event.type === 'message');
  const messageIndex = new Map(messageEvents.map((event, index) => [event.messageId, index]));
  const included = new Set(selector.messageIds);

  for (const messageId of selector.messageIds) {
    if (!messageIndex.has(messageId))
      throw new Error(`Message ${messageId} was not found in selected chat`);
  }

  for (const messageId of selector.messageIds) {
    const idx = messageIndex.get(messageId)!;
    const from = Math.max(0, idx - (selector.contextBefore ?? 0));
    const to = Math.min(messageEvents.length - 1, idx + (selector.contextAfter ?? 0));
    for (const event of messageEvents.slice(from, to + 1))
      included.add(event.messageId);
  }

  if (selector.includeReplies) {
    const queue = [...included];
    let cursor = 0;
    while (cursor < queue.length) {
      const message = messageEvents[messageIndex.get(queue[cursor]!)!];
      const replyTo = message?.replyToMessageId;
      if (replyTo && messageIndex.has(replyTo) && !included.has(replyTo)) {
        included.add(replyTo);
        queue.push(replyTo);
      }
      cursor++;
    }
  }

  const selected = events.filter(event => {
    const ids = eventMessageIds(event);
    return event.type === 'service' || event.type === 'runtime'
      ? false
      : ids.some(id => included.has(id));
  });

  return {
    events: selected,
    startMs: selected[0]?.receivedAtMs ?? 0,
    endMs: selected[selected.length - 1]?.receivedAtMs ?? 0,
  };
};

export const selectFixtureEvents = (
  events: PipelineEvent[],
  selector: FixtureEventSelector,
): SelectedFixtureEvents => {
  switch (selector.type) {
  case 'messageRange':
    return selectMessageRange(events, selector);
  case 'receivedRange':
    return selectedByTime(events, selector.fromMs, selector.toMs);
  case 'messages':
    return selectExplicitMessages(events, selector);
  }
};

export const buildEvalFixture = (
  chatId: string,
  selected: SelectedFixtureEvents,
  options: {
    name?: string;
    turnResponses?: TurnResponseV2[];
  } = {},
): EvalFixture => {
  let ic = createEmptyIC(chatId);
  for (const event of selected.events)
    ic = reduce(ic, event);
  return {
    name: options.name ?? chatId,
    ic,
    ...(options.turnResponses && options.turnResponses.length > 0 ? { turnResponses: options.turnResponses } : {}),
  };
};

const assertSerializableObject = (value: object): void => {
  const ctor = value.constructor?.name;
  if (Buffer.isBuffer(value)) throw new Error('Cannot serialize Buffer values into eval fixtures');
  if (ctor && ctor !== 'Object' && ctor !== 'Array')
    throw new Error(`Cannot serialize ${ctor} values into eval fixtures`);
};

const toTsLiteral = (value: unknown, indent = 0): string => {
  const pad = ' '.repeat(indent);
  const nextPad = ' '.repeat(indent + 2);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => `${nextPad}[${toTsLiteral(k)}, ${toTsLiteral(v, indent + 2)}]`)
      .join(',\n');
    return entries ? `new Map([\n${entries},\n${pad}])` : 'new Map()';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map(v => `${nextPad}${toTsLiteral(v, indent + 2)}`).join(',\n')},\n${pad}]`;
  }
  if (typeof value === 'object') {
    assertSerializableObject(value);
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${nextPad}${JSON.stringify(k)}: ${toTsLiteral(v, indent + 2)}`)
      .join(',\n');
    return entries ? `{\n${entries},\n${pad}}` : '{}';
  }

  throw new Error(`Cannot serialize value of type ${typeof value}`);
};

export const serializeEvalFixture = (fixture: EvalFixture, evalsImportPath = '../../../src/evals'): string =>
  `import type { EvalFixture } from '${evalsImportPath}';\n\n`
  + `export default ${toTsLiteral(fixture)} satisfies EvalFixture;\n`;

export const fixtureToXml = (fixture: EvalFixture): string =>
  rcToXml(render(fixture.ic, {}));

export const exportEvalFixtureFromDb = async (
  db: DB,
  options: FixtureExportOptions,
): Promise<{ fixture: EvalFixture; selected: SelectedFixtureEvents }> => {
  const allEvents = loadEvents(db, options.chatId);
  const selected = selectFixtureEvents(allEvents, options.selector);
  const turnResponses = options.includeTurnResponses
    ? (await loadTurnResponses(
        db,
        options.chatId,
        Math.max(0, selected.startMs - (options.turnResponsesBeforeMs ?? 0)),
        options.turnResponsesAgentId ?? 'main',
      )).filter(tr => tr.requestedAtMs <= selected.endMs + (options.turnResponsesAfterMs ?? 0))
    : undefined;
  const fixture = buildEvalFixture(options.chatId, selected, {
    name: options.name,
    turnResponses,
  });
  return { fixture, selected };
};
