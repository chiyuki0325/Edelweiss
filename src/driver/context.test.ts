import { describe, expect, it } from 'vitest';
import type { Message } from 'xsai';

import { composeContext, prepareChatMessagesForSend, prepareResponsesInputForSend, sanitizeToolCallIdsForMessagesApi } from './context';
import type { ResponseInputContent } from './responses-types';
import type { ResponsesTRDataItem, TRDataEntry, TurnResponse } from './types';
import type { FeatureFlags } from '../config/config';
import type { RenderedContext } from '../rendering/types';

type AnyMsg = Record<string, any>;

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, data: TRDataEntry[]): TurnResponse => ({
  requestedAtMs: ts,
  provider: 'openai-chat',
  data,
  inputTokens: 0,
  outputTokens: 0,
});

const responsesTR = (ts: number, data: ResponsesTRDataItem[], compat?: string): TurnResponse => ({
  requestedAtMs: ts,
  provider: 'responses',
  data,
  inputTokens: 0,
  outputTokens: 0,
  ...(compat ? { reasoningSignatureCompat: compat } : {}),
});

const assistantMsg = (text: string): TRDataEntry => ({ role: 'assistant', content: text });
const toolCallMsg = (id: string, name: string, args: string): TRDataEntry => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const toolResultMsg = (id: string, content: string | ResponseInputContent[]): TRDataEntry => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

const longToolResult = (label: string): string => `${label}:${'x'.repeat(1000)}`;
const imageToolResult = (detail: 'auto' | 'low' | 'high', label: string): ResponseInputContent[] => [{
  type: 'input_image',
  image_url: `data:image/png;base64,${label}`,
  detail,
}];

const flags = (overrides: Partial<FeatureFlags> = {}): FeatureFlags => ({
  trimStaleNoToolCallTurnResponses: false,
  trimSelfMessagesCoveredBySendToolCalls: false,
  trimToolResults: false,
  ...overrides,
});

describe('sanitizeToolCallIdsForMessagesApi', () => {
  it('sanitizes assistant/tool ids without mutating input', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [{ id: 'send_message:103', type: 'function', function: { name: 'send_message', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'send_message:103', content: '{"ok":true}' },
    ] as unknown as Message[];

    const result = sanitizeToolCallIdsForMessagesApi(messages);

    expect(((messages[0] as AnyMsg).tool_calls[0] as AnyMsg).id).toBe('send_message:103');
    expect((messages[1] as AnyMsg).tool_call_id).toBe('send_message:103');
    expect(((result[0] as AnyMsg).tool_calls[0] as AnyMsg).id).toBe('send_message_103');
    expect((result[1] as AnyMsg).tool_call_id).toBe('send_message_103');
  });

  it('deduplicates collisions after sanitization', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'a:b', type: 'function', function: { name: 'send_message', arguments: '{}' } },
          { id: 'a?b', type: 'function', function: { name: 'send_message', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a:b', content: 'one' },
      { role: 'tool', tool_call_id: 'a?b', content: 'two' },
    ] as unknown as Message[];

    const result = sanitizeToolCallIdsForMessagesApi(messages);
    const toolCalls = (result[0] as AnyMsg).tool_calls as AnyMsg[];

    expect(toolCalls.map(tc => tc.id)).toEqual(['a_b', 'a_b_2']);
    expect((result[1] as AnyMsg).tool_call_id).toBe('a_b');
    expect((result[2] as AnyMsg).tool_call_id).toBe('a_b_2');
  });
});

describe('trimToolResults via composeContext', () => {
  it('does not trim when feature flag is off', () => {
    const longContent = longToolResult('full');
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', longContent)]),
      tr(300, [toolCallMsg('tc2', 'read', '{}'), toolResultMsg('tc2', longContent)]),
      tr(400, [toolCallMsg('tc3', 'read', '{}'), toolResultMsg('tc3', longContent)]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: false }));
    expect(result).not.toBeNull();

    // All tool results should contain the full long content
    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    for (const tr of toolResults)
      expect((tr as any).content).toBe(longContent);
  });

  it('keeps only the last 5 oversized tool results untrimmed', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 7 }, (_, i) => longToolResult(`oversized${i + 1}`));
    const trs = contents.map((content, i) =>
      tr(200 + i * 100, [toolCallMsg(`tc${i + 1}`, 'read', '{}'), toolResultMsg(`tc${i + 1}`, content)]));

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    expect(toolResults).toHaveLength(7);

    expect((toolResults[0] as any).content).toContain('[trimmed');
    expect((toolResults[0] as any).content.length).toBeLessThan(contents[0]!.length);
    expect((toolResults[1] as any).content).toContain('[trimmed');

    for (let i = 2; i < toolResults.length; i++)
      expect((toolResults[i] as any).content).toBe(contents[i]);
  });

  it('does not count within-limit tool results toward the keep budget', () => {
    const shortContent = 'short result';
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const oversizedContents = Array.from({ length: 6 }, (_, i) => longToolResult(`oversized${i + 1}`));
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', shortContent)]),
      ...oversizedContents.map((content, i) =>
        tr(300 + i * 100, [toolCallMsg(`tc${i + 2}`, 'read', '{}'), toolResultMsg(`tc${i + 2}`, content)])),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    expect((toolResults[0] as any).content).toBe(shortContent);
    expect((toolResults[1] as any).content).toContain('[trimmed');
    for (let i = 2; i < toolResults.length; i++)
      expect((toolResults[i] as any).content).toBe(oversizedContents[i - 1]);
  });

  it('does not count low-detail images and downgrades older oversized images', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const lowDetailImage = imageToolResult('low', 'low0');
    const oversizedImages = [
      imageToolResult('auto', 'auto1'),
      ...Array.from({ length: 5 }, (_, i) => imageToolResult('high', `high${i + 1}`)),
    ];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read_image', '{}'), toolResultMsg('tc1', lowDetailImage)]),
      ...oversizedImages.map((content, i) =>
        tr(300 + i * 100, [toolCallMsg(`tc${i + 2}`, 'read_image', '{}'), toolResultMsg(`tc${i + 2}`, content)])),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    expect((toolResults[0] as any).content).toEqual(lowDetailImage);
    expect((toolResults[1] as any).content).toEqual([{ ...oversizedImages[0]![0]!, detail: 'low' }]);

    for (let i = 2; i < toolResults.length; i++)
      expect((toolResults[i] as any).content).toEqual(oversizedImages[i - 1]);
  });

  it('preserves assistant entries when trimming older oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [
        toolCallMsg('tc1', 'read', '{"path":"/etc"}'),
        toolResultMsg('tc1', longToolResult('oldest')),
        assistantMsg('I read the file'),
      ]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [
          toolCallMsg(`tc${i + 2}`, 'read', '{}'),
          toolResultMsg(`tc${i + 2}`, longToolResult(`recent${i + 1}`)),
        ])),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as any).role === 'assistant');
    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    expect((toolResults[0] as any).content).toContain('[trimmed');
    expect(assistants.some(m => (m as any).content === 'I read the file')).toBe(true);
  });

  it('does nothing when there are only 5 oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 5 }, (_, i) => longToolResult(`oversized${i + 1}`));
    const trs = contents.map((content, i) =>
      tr(200 + i * 100, [toolCallMsg(`tc${i + 1}`, 'read', '{}'), toolResultMsg(`tc${i + 1}`, content)]));

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    for (let i = 0; i < toolResults.length; i++)
      expect((toolResults[i] as any).content).toBe(contents[i]);
  });

  it('trimmed content preserves head and tail', () => {
    const content = `HEAD${  'x'.repeat(800)  }TAIL`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', content)]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [toolCallMsg(`tc${i + 2}`, 'read', '{}'), toolResultMsg(`tc${i + 2}`, longToolResult(`recent${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    const trimmed = (toolResults[0] as any).content as string;
    expect(trimmed).toContain('HEAD');
    expect(trimmed).toContain('TAIL');
    expect(trimmed).toContain('[trimmed');
  });

  it('sanitizes invalid tool call ids in composed context', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('send_message:103', 'send_message', '{}'), toolResultMsg('send_message:103', '{"ok":true}')]),
    ];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const assistant = result!.messages.find(m => (m as AnyMsg).role === 'assistant') as AnyMsg;
    const tool = result!.messages.find(m => (m as AnyMsg).role === 'tool') as AnyMsg;
    expect((assistant.tool_calls[0] as AnyMsg).id).toBe('send_message_103');
    expect(tool.tool_call_id).toBe('send_message_103');
  });
});

// ── Responses provider tests ──

describe('composeContext with responses provider TRs', () => {
  it('converts responses TR data to openai-chat messages', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ])];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).content).toBe('hi there');
  });

  it('preserves function_call_output as tool messages', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' },
    ])];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const toolMsgs = result!.messages.filter(m => (m as AnyMsg).role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as AnyMsg).tool_call_id).toBe('fc1');
    expect((toolMsgs[0] as AnyMsg).content).toBe('{"ok":true}');
  });

  it('preserves reasoning when compat matches', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'sig_abc' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ], 'anthropic')];

    const result = composeContext(rc, trs, 100000, 'anthropic');
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).reasoning_opaque).toBe('sig_abc');
    expect((assistants[0] as AnyMsg).reasoning_text).toBe('thinking');
  });

  it('strips reasoning when compat mismatches', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'sig_abc' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ], 'anthropic')];

    const result = composeContext(rc, trs, 100000, 'openai');
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).reasoning_opaque).toBeUndefined();
  });

  it('trHasToolCalls detects function_call items in responses TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trsWithToolCalls = [
      responsesTR(200, [{ type: 'function_call', call_id: 'fc1', name: 'fn', arguments: '{}', status: 'completed' }]),
      responsesTR(300, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'text only' }] }]),
    ];

    const result = composeContext(rc, trsWithToolCalls, 100000, undefined, flags({ trimStaleNoToolCallTurnResponses: true }));
    expect(result).not.toBeNull();
    // Both TRs should survive — only 2 total, and the no-tool-call one is kept (< KEEP_NO_TOOL_CALL_TRS)
    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(1);
  });

  it('trimToolResults keeps only the last 5 oversized function_call_output items in responses TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const outputs = Array.from({ length: 6 }, (_, i) => longToolResult(`responses${i + 1}`));
    const trs = outputs.map((output, i) =>
      responsesTR(200 + i * 100, [
        { type: 'function_call', call_id: `fc${i + 1}`, name: 'fn', arguments: '{}', status: 'completed' },
        { type: 'function_call_output', call_id: `fc${i + 1}`, output },
      ]));

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolMsgs = result!.messages.filter(m => (m as AnyMsg).role === 'tool');
    expect(toolMsgs).toHaveLength(6);
    expect((toolMsgs[0] as AnyMsg).content).toContain('[trimmed');

    for (let i = 1; i < toolMsgs.length; i++)
      expect((toolMsgs[i] as AnyMsg).content).toBe(outputs[i]);
  });

  it('handles mixed openai-chat and responses TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [
      tr(200, [assistantMsg('from chat')]),
      responsesTR(300, [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'from responses' }] },
      ]),
    ];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect((assistants[0] as AnyMsg).content).toBe('from chat');
    expect((assistants[1] as AnyMsg).content).toBe('from responses');
  });
});

describe('send-boundary preparation helpers', () => {
  it('prepareChatMessagesForSend converts internal user content parts to chat format', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'look at this:' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'low' },
      ],
    }] as unknown as Message[];

    const prepared = prepareChatMessagesForSend(messages);
    expect(prepared).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } },
      ],
    }]);
  });

  it('prepareChatMessagesForSend trims images after tool-result image extraction', () => {
    const messages = [{
      role: 'tool',
      tool_call_id: 'tc1',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'low' }],
    }] as unknown as Message[];

    const prepared = prepareChatMessagesForSend(messages, 0);
    expect(prepared.some(msg => Array.isArray((msg as AnyMsg).content)
      && (msg as AnyMsg).content.some((part: AnyMsg) => part.type === 'image_url'))).toBe(false);
    expect(prepared).toContainEqual({ role: 'tool', tool_call_id: 'tc1', content: '[image]' });
    expect(prepared).toContainEqual({ role: 'user', content: [{ type: 'text', text: '[images omitted]' }] });
  });

  it('prepareResponsesInputForSend trims images at the final send boundary', () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'low' }],
    }] as unknown as Message[];

    const prepared = prepareResponsesInputForSend(messages, 0);
    expect(prepared).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[images omitted]' }],
    }]);
  });
});
