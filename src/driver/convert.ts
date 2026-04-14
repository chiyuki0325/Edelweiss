// TR data format conversion between openai-chat and responses.
// Called at API boundaries — never at storage time.
//
// Reasoning is preserved through conversions — sanitizeReasoningForTR already
// strips reasoning when compat mismatches. Data reaching these functions has
// valid reasoning that should survive the round-trip.
//
// Mapping: responses encrypted_content ↔ openai-chat reasoning_opaque
//          responses summary           ↔ openai-chat reasoning_text

import type { Message } from 'xsai';

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
import type { ExtendedMessage, ExtendedMessagePart, ResponsesTRDataItem, TRAssistantEntry, TRDataEntry, TRToolResultEntry } from './types';

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
// Chat Completions uses image_url/text format. Additionally, tool results may not
// support images, so images are extracted into separate user messages.

export const prepareMessagesForChat = (messages: Message[]): Message[] => {
  const result: Message[] = [];
  let pendingToolImageMessage: Message | null = null;

  const flushPendingToolImages = () => {
    if (!pendingToolImageMessage) return;
    result.push(pendingToolImageMessage);
    pendingToolImageMessage = null;
  };

  for (const msg of messages) {
    const m = msg as ExtendedMessage;
    if (m.role === 'tool' && Array.isArray(m.content)) {
      // Tool results: extract images into separate user messages
      const parts = m.content as ResponseInputContent[];
      const textParts = parts.filter(p => p.type !== 'input_image');
      const imageParts = parts.filter((p): p is import('./responses-types').ResponseInputImage => p.type === 'input_image');

      const textContent = textParts.map(p => (p as import('./responses-types').ResponseInputText).text).join('\n');
      result.push({ ...msg, content: textContent || '[image]' } as Message);

      if (imageParts.length > 0) {
        const imageContent = imageParts.map(p => ({
          type: 'image_url' as const,
          image_url: { url: p.image_url, detail: p.detail ?? 'auto' },
        }));

        if (pendingToolImageMessage) {
          const content = pendingToolImageMessage.content as ExtendedMessagePart[];
          content.push(...imageContent);
        } else {
          pendingToolImageMessage = {
            role: 'user',
            content: imageContent,
          } as Message;
        }
      }
    } else if (m.role === 'tool') {
      result.push(msg);
    } else if (Array.isArray(m.content)) {
      flushPendingToolImages();

      // User/other messages: convert input_image → image_url, input_text → text
      result.push({
        ...msg,
        content: responsesPartsToChatParts(m.content as ResponseInputContent[]),
      } as Message);
    } else {
      flushPendingToolImages();
      result.push(msg);
    }
  }

  flushPendingToolImages();

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
