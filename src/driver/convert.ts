// TR data format conversion between openai-chat, responses, and anthropic.
// Called at API boundaries — never at storage time.
//
// Reasoning is preserved through conversions — sanitizeReasoningForTR already
// strips reasoning when compat mismatches. Data reaching these functions has
// valid reasoning that should survive the round-trip.
//
// Mapping: responses encrypted_content ↔ openai-chat reasoning_opaque
//          responses summary           ↔ openai-chat reasoning_text
//          anthropic redacted_thinking ↔ openai-chat reasoning_opaque
//          anthropic thinking          ↔ openai-chat reasoning_text

import type { Message } from 'xsai';

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from './anthropic-types';
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
  ResponseTool,
} from './responses-types';
import type {
  AnthropicTRDataEntry,
  AnthropicToolResultGroupEntry,
  ExtendedMessage,
  ExtendedMessagePart,
  ResponsesTRDataItem,
  TRAssistantEntry,
  TRDataEntry,
  TRToolResultEntry,
} from './types';

// ── Content parts conversion: Chat ↔ Responses ──
//
// Driver intermediate messages carry user/tool image parts in Responses format
// (`input_text` / `input_image`). Chat Completions uses `text` / `image_url`.

export const chatPartsToResponsesParts = (parts: ExtendedMessagePart[]): ResponseInputContent[] =>
  parts.flatMap((p): ResponseInputContent[] =>
    p.type === 'image_url' && p.image_url
      ? [{ type: 'input_image', image_url: p.image_url.url, detail: (p.image_url.detail ?? 'auto') as 'auto' | 'low' | 'high' }]
      : p.type === 'text' && typeof p.text === 'string'
        ? [{ type: 'input_text', text: p.text }]
        : []);

export const responsesPartsToChatParts = (parts: ResponseInputContent[]): ExtendedMessagePart[] =>
  parts.map(p =>
    p.type === 'input_image'
      ? { type: 'image_url', image_url: { url: p.image_url, detail: p.detail ?? 'auto' } } as ExtendedMessagePart
      : { type: 'text', text: p.text } as ExtendedMessagePart);

// ── Prepare intermediate messages for Chat Completions API ──
// Intermediate messages use Responses format (input_image/input_text) for content parts.
// Chat Completions uses image_url/text format. Additionally, image-bearing tool
// results are moved wholesale into follow-up user messages so their text/image
// ordering stays intact.

export const prepareMessagesForChat = (messages: Message[]): Message[] => {
  const result: Message[] = [];
  let pendingToolResultMessage: Message | null = null;
  const toolCallNames = new Map<string, string>();

  const flushPendingToolResults = () => {
    if (!pendingToolResultMessage) return;
    result.push(pendingToolResultMessage);
    pendingToolResultMessage = null;
  };

  for (const msg of messages) {
    const m = msg as ExtendedMessage;
    if (Array.isArray(m.tool_calls)) {
      for (const toolCall of m.tool_calls)
        toolCallNames.set(toolCall.id, toolCall.function.name);
    }

    if (m.role === 'tool' && Array.isArray(m.content)) {
      const chatParts = responsesPartsToChatParts(m.content as ResponseInputContent[]);
      const hasImages = chatParts.some(part => part.type === 'image_url');

      if (hasImages) {
        result.push({ ...msg, content: '' } as Message);

        const toolName = typeof m.tool_call_id === 'string' ? toolCallNames.get(m.tool_call_id) : undefined;
        const movedParts: ExtendedMessagePart[] = [
          { type: 'text', text: toolName ? `The result of tool ${toolName}` : 'The result of a tool call' },
          ...chatParts,
        ];

        if (pendingToolResultMessage) {
          const content = pendingToolResultMessage.content as ExtendedMessagePart[];
          content.push(...movedParts);
        } else {
          pendingToolResultMessage = {
            role: 'user',
            content: movedParts,
          } as Message;
        }
      } else {
        const textContent = chatParts.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
        result.push({ ...msg, content: textContent } as Message);
      }
    } else if (m.role === 'tool') {
      result.push(msg);
    } else if (Array.isArray(m.content)) {
      flushPendingToolResults();

      // User/other messages: convert input_image → image_url, input_text → text
      result.push({
        ...msg,
        content: responsesPartsToChatParts(m.content as ResponseInputContent[]),
      } as Message);
    } else {
      flushPendingToolResults();
      result.push(msg);
    }
  }

  flushPendingToolResults();

  return result;
};

// ── Shared assistant → Responses input items ──
// Extracts reasoning, message content, and tool_calls from an openai-chat-shaped
// assistant entry into Responses input items. Used by both chatTRToResponsesInput
// and messagesToResponsesInput — the two functions differ only in how they handle
// user and tool roles.
const assistantToResponsesItems = (
  m: ExtendedMessage,
  items: ResponseInputItem[],
) => {
  // Reasoning → ResponseInputReasoning (before message/tool_calls)
  if (m.reasoning_opaque)
    items.push({
      type: 'reasoning', id: `rs_${items.length}`,
      summary: m.reasoning_text ? [{ type: 'summary_text', text: m.reasoning_text }] : [],
      encrypted_content: m.reasoning_opaque,
    } as ResponseInputReasoning);

  // Text content → message with output_text
  if (m.content != null) {
    const content: ResponseInputContent[] = typeof m.content === 'string'
      ? [{ type: 'output_text', text: m.content }]
      : Array.isArray(m.content)
        ? (m.content as ExtendedMessagePart[]).flatMap(p => p.type === 'text' && typeof p.text === 'string' ? [{ type: 'output_text' as const, text: p.text }] : [])
        : [];
    if (content.length > 0)
      items.push({ type: 'message', role: 'assistant', content } as ResponseInputMessage);
  }

  // Tool calls → function_call items
  for (const tc of m.tool_calls ?? [])
    items.push({
      type: 'function_call', call_id: tc.id,
      name: tc.function.name, arguments: tc.function.arguments, status: 'completed',
    } as ResponseFunctionToolCallItem);
};

// ── openai-chat TR data → Responses API input items ──
// Used when replaying openai-chat TRs to a Responses API model.
// Tool result content is already in Responses format (canonical), so pass through directly.
export const chatTRToResponsesInput = (entries: TRDataEntry[]): ResponseInputItem[] => {
  const items: ResponseInputItem[] = [];
  for (const entry of entries)
    entry.role === 'assistant'
      ? assistantToResponsesItems(entry as TRAssistantEntry, items)
      : entry.role === 'tool' && items.push({
        type: 'function_call_output',
        call_id: (entry as TRToolResultEntry).tool_call_id,
        output: (entry as TRToolResultEntry).content,
      } as ResponseFunctionCallOutputItem);
  return items;
};

// ── Responses TR data → openai-chat Message[] ──
// Used when replaying responses TRs to a Chat Completions model.
// Handles all 4 item types: message, function_call, reasoning, function_call_output.
export const responsesOutputToMessages = (items: ResponsesTRDataItem[]): Message[] => {
  const messages: Message[] = [];

  let pendingContent: string | undefined;
  let pendingToolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let pendingReasoningOpaque: string | undefined;
  let pendingReasoningText: string | undefined;

  const flushAssistant = () => {
    if (pendingContent == null && pendingToolCalls.length === 0
        && pendingReasoningOpaque == null && pendingReasoningText == null) return;
    const msg: ExtendedMessage = { role: 'assistant' };
    if (pendingContent != null) msg.content = pendingContent;
    if (pendingToolCalls.length > 0) msg.tool_calls = pendingToolCalls;
    if (pendingReasoningOpaque != null) msg.reasoning_opaque = pendingReasoningOpaque;
    if (pendingReasoningText != null) msg.reasoning_text = pendingReasoningText;
    messages.push(msg as Message);
    pendingContent = undefined;
    pendingToolCalls = [];
    pendingReasoningOpaque = undefined;
    pendingReasoningText = undefined;
  };

  for (const item of items) {
    if (item.type === 'message') {
      for (const block of (item as ResponseOutputMessage).content)
        pendingContent = (pendingContent ?? '')
          + (block.type === 'output_text' ? block.text : block.type === 'refusal' ? block.refusal : '');
    } else if (item.type === 'function_call') {
      const fc = item as ResponseOutputFunctionCall;
      pendingToolCalls.push({ id: fc.call_id, type: 'function', function: { name: fc.name, arguments: fc.arguments } });
    } else if (item.type === 'reasoning') {
      if (item.encrypted_content) pendingReasoningOpaque = item.encrypted_content as string;
      const summaryText = Array.isArray(item.summary)
        ? (item.summary as { text: string }[]).map(s => s.text).join('\n')
        : '';
      if (summaryText) pendingReasoningText = summaryText;
    } else if (item.type === 'function_call_output') {
      flushAssistant();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output } as unknown as Message);
    }
  }

  flushAssistant();
  return messages;
};

// ── Intermediate Message[] → Responses API input items ──
// Intermediate messages use Responses format for content parts (input_image/input_text).
// User message content arrays are already ResponseInputContent[], so pass through directly.
export const messagesToResponsesInput = (messages: Message[]): ResponseInputItem[] => {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    const m = msg as ExtendedMessage;

    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        items.push({ type: 'message', role: 'user', content: m.content } as ResponseInputMessage);
      } else if (Array.isArray(m.content) && m.content.length > 0) {
        items.push({ type: 'message', role: 'user', content: m.content as ResponseInputContent[] } as ResponseInputMessage);
      }
    } else if (m.role === 'assistant') {
      assistantToResponsesItems(m, items);
    } else if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content,
      } as ResponseFunctionCallOutputItem);
    }
  }

  return items;
};

// ── Tool schema → Responses API function tool ──
interface ToolLike {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
}

export const xsaiToolToResponsesTool = (t: ToolLike): ResponseTool => ({
  type: 'function',
  name: t.function.name,
  parameters: t.function.parameters as Record<string, unknown>,
  strict: false,
  ...(t.function.description ? { description: t.function.description } : {}),
});

// ── Tool schema → Anthropic API function tool ──
export const xsaiToolToAnthropicTool = (t: ToolLike): AnthropicTool => ({
  name: t.function.name,
  input_schema: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

// ── Anthropic TR data → intermediate Message[] ──
// Used when replaying Anthropic TRs into context for any provider.
// Thinking blocks convert to reasoning_text/reasoning_opaque (openai-chat compat).
// Tool result content stays in canonical ResponseInputContent[] format.

const anthropicEntryToMessages = (entry: AnthropicTRDataEntry): Message[] => {
  if (entry.role === 'assistant') {
    const msg: TRAssistantEntry = { role: 'assistant' };

    const textParts = entry.content.filter((b): b is AnthropicTextBlock => b.type === 'text');
    const toolUses = entry.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
    const thinking = entry.content.find((b): b is { type: 'thinking'; thinking: string; signature?: string } => b.type === 'thinking');
    const redacted = entry.content.find((b): b is { type: 'redacted_thinking'; data: string } => b.type === 'redacted_thinking');

    if (textParts.length === 1) {
      msg.content = textParts[0]!.text;
    } else if (textParts.length > 1) {
      msg.content = textParts.map(b => b.text).join('');
    }

    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map(b => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    }

    if (thinking) msg.reasoning_text = thinking.thinking;
    if (thinking?.signature != null) msg.reasoning_opaque = thinking.signature;
    else if (redacted) msg.reasoning_opaque = redacted.data;

    return [msg as Message];
  }

  // role === 'user': one tool result per item in content
  return (entry as AnthropicToolResultGroupEntry).content.map(block => ({
    role: 'tool' as const,
    tool_call_id: block.tool_use_id,
    content: block.content,
    requiresFollowUp: block.requiresFollowUp,
  } as unknown as Message));
};

export const anthropicTRToMessages = (entries: AnthropicTRDataEntry[]): Message[] =>
  entries.flatMap(anthropicEntryToMessages);

// ── Intermediate Message[] → Anthropic Messages API format ──
// Converts openai-chat-shaped intermediate messages to Anthropic wire format.
// Batches consecutive tool result messages into a single user message.
// Merges consecutive user content parts into a single user message.

const parseImageUrl = (url: string): AnthropicImageBlock['source'] => {
  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    const header = url.slice(0, commaIdx);
    const data = url.slice(commaIdx + 1);
    const mediaType = header.slice('data:'.length).replace(';base64', '');
    return { type: 'base64', media_type: mediaType, data };
  }
  return { type: 'url', url };
};

const convertUserPart = (part: ExtendedMessagePart): Array<AnthropicTextBlock | AnthropicImageBlock> => {
  if ((part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string')
    return [{ type: 'text', text: part.text }];
  if (part.type === 'input_image' && typeof part.image_url === 'string')
    return [{ type: 'image', source: parseImageUrl(part.image_url) }];
  if (part.type === 'image_url' && part.image_url)
    return [{ type: 'image', source: parseImageUrl((part.image_url as { url: string }).url) }];
  return [];
};

const responseContentToAnthropicParts = (parts: ResponseInputContent[]): Array<AnthropicTextBlock | AnthropicImageBlock> =>
  parts.flatMap((part): Array<AnthropicTextBlock | AnthropicImageBlock> =>
    part.type === 'input_text'
      ? [{ type: 'text', text: part.text }]
      : part.type === 'input_image'
        ? [{ type: 'image', source: parseImageUrl(part.image_url) }]
        : []);

const convertToolMessageToToolResultBlock = (m: ExtendedMessage): AnthropicToolResultBlock => {
  const content = m.content as string | ResponseInputContent[] | undefined;
  const converted: AnthropicToolResultBlock['content'] = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? responseContentToAnthropicParts(content)
      : '';
  return { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: converted };
};

export const messagesToAnthropicMessages = (messages: Message[]): AnthropicMessage[] => {
  const result: AnthropicMessage[] = [];
  type PendingUser = { type: 'parts'; parts: Array<AnthropicTextBlock | AnthropicImageBlock> };
  type PendingTool = { type: 'results'; blocks: AnthropicToolResultBlock[] };
  let pending: PendingUser | PendingTool | null = null;

  const flush = () => {
    if (!pending) return;
    if (pending.type === 'parts' && pending.parts.length > 0) {
      result.push({ role: 'user', content: pending.parts } as AnthropicMessage);
    } else if (pending.type === 'results' && pending.blocks.length > 0) {
      result.push({ role: 'user', content: pending.blocks as AnthropicUserContentBlock[] } as AnthropicMessage);
    }
    pending = null;
  };

  for (const msg of messages) {
    const m = msg as ExtendedMessage;

    if (m.role === 'user') {
      if (pending?.type === 'results') flush();
      const newParts = typeof m.content === 'string'
        ? (m.content ? [{ type: 'text' as const, text: m.content }] : [])
        : Array.isArray(m.content)
          ? (m.content as ExtendedMessagePart[]).flatMap(convertUserPart)
          : [];
      if (pending?.type === 'parts') {
        pending.parts.push(...newParts);
      } else {
        flush();
        pending = { type: 'parts', parts: newParts };
      }
    } else if (m.role === 'tool') {
      if (pending?.type === 'parts') flush();
      const block = convertToolMessageToToolResultBlock(m);
      if (pending?.type === 'results') {
        pending.blocks.push(block);
      } else {
        pending = { type: 'results', blocks: [block] };
      }
    } else if (m.role === 'assistant') {
      flush();
      const content: AnthropicAssistantContentBlock[] = [];

      // Thinking blocks first per Anthropic spec.
      // Keep empty strings too: some providers require replaying even empty
      // thinking/signature fields across tool-call turns.
      if (m.reasoning_text != null) {
        content.push({
          type: 'thinking',
          thinking: m.reasoning_text,
          ...(m.reasoning_opaque != null ? { signature: m.reasoning_opaque } : {}),
        });
      } else if (m.reasoning_opaque != null) {
        content.push({ type: 'redacted_thinking', data: m.reasoning_opaque });
      }

      // Text content
      if (typeof m.content === 'string' && m.content)
        content.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content))
        for (const part of m.content as ExtendedMessagePart[])
          if (part.type === 'text' && typeof part.text === 'string')
            content.push({ type: 'text', text: part.text });

      // Tool calls
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }

      if (content.length > 0)
        result.push({ role: 'assistant', content } as AnthropicMessage);
    }
  }

  flush();
  return result;
};
