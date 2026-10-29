import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
  mapStoredMessagesToChatMessages,
  type ContentBlock,
  type StoredMessage,
  type ToolCall,
} from '@langchain/core/messages';
import sharp, { type Sharp } from 'sharp';

import type {
  ConversationEntry as LegacyConversationEntry,
  InputPart as LegacyInputPart,
  OutputPart as LegacyOutputPart,
  OutputMessage as LegacyOutputMessage,
} from '../unified-api/types';

export type DriverMessage = HumanMessage | SystemMessage | AIMessage | ToolMessage;
export type DriverToolCall = ToolCall & { id: string };
export type DriverToolMessage = ToolMessage & {
  readonly callId: string;
  readonly payload: ToolMessage['content'];
  readonly requiresFollowUp: boolean;
};

export type DriverImageBlock = {
  readonly type: 'image';
  data: string | Uint8Array | Sharp;
  mimeType?: string;
  id?: string;
  metadata?: { detail?: 'high' | 'low' };
  [key: string]: unknown;
};

export type DriverInputBlock = ContentBlock.Text | DriverImageBlock;

const isSharp = (value: unknown): value is Sharp =>
  typeof value === 'object' && value !== null
  && typeof (value as { toBuffer?: unknown }).toBuffer === 'function'
  && typeof (value as { metadata?: unknown }).metadata === 'function';

export const textBlock = (text: string): ContentBlock.Text => ({ type: 'text', text });

export const imageBlock = (
  image: Sharp,
  detail: 'high' | 'low' | undefined,
): DriverImageBlock => ({
  type: 'image',
  data: image,
  mimeType: 'image/png',
  ...(detail ? { metadata: { detail } } : {}),
});

export const humanMessage = (content: string | DriverInputBlock[]): HumanMessage =>
  new HumanMessage({ content });

export const systemMessage = (content: string): SystemMessage =>
  new SystemMessage({ content });

export const aiMessage = (fields: ConstructorParameters<typeof AIMessage>[0]): AIMessage =>
  new AIMessage(fields);

export const toolMessage = (
  toolCallId: string,
  content: string | DriverInputBlock[],
  requiresFollowUp: boolean,
): DriverToolMessage => {
  const message = new ToolMessage({
    content,
    tool_call_id: toolCallId,
    metadata: { requiresFollowUp },
  });
  Object.defineProperties(message, {
    callId: { get: () => message.tool_call_id },
    payload: { get: () => message.content },
    requiresFollowUp: { get: () => toolResultRequiresFollowUp(message) },
  });
  return message as DriverToolMessage;
};

export const isDriverMessage = (message: BaseMessage): message is DriverMessage =>
  isHumanMessage(message) || isSystemMessage(message) || isAIMessage(message) || isToolMessage(message);

export const messageText = (message: BaseMessage): string => {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('');
};

export const messageBlocks = (message: BaseMessage): ContentBlock[] =>
  typeof message.content === 'string' ? [textBlock(message.content)] : message.content;

export const toolCalls = (messages: BaseMessage[]): DriverToolCall[] =>
  messages.flatMap(message => {
    if (!isAIMessage(message)) return [];
    return (message.tool_calls ?? [])
      .filter((call): call is DriverToolCall => typeof call.id === 'string');
  });

export const toolCallArgs = (call: ToolCall): string =>
  JSON.stringify(call.args ?? {});

export const toolResultRequiresFollowUp = (message: ToolMessage): boolean =>
  message.metadata?.requiresFollowUp === true;

export const cloneMessage = (message: DriverMessage, content = message.content): DriverMessage => {
  if (isHumanMessage(message))
    return new HumanMessage({ ...message, content });
  if (isSystemMessage(message))
    return new SystemMessage({ ...message, content });
  if (isToolMessage(message))
    return new ToolMessage({ ...message, content, tool_call_id: message.tool_call_id });
  return new AIMessage({ ...message, content, tool_calls: message.tool_calls });
};

export const withoutReasoning = (messages: DriverMessage[]): DriverMessage[] => {
  const result: DriverMessage[] = [];
  for (const message of messages) {
    if (!isAIMessage(message)) {
      result.push(message);
      continue;
    }
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.filter(block =>
          block.type !== 'reasoning'
          && block.type !== 'thinking'
          && block.type !== 'redacted_thinking');
    const additional_kwargs = { ...message.additional_kwargs };
    delete additional_kwargs.reasoning;
    delete additional_kwargs.reasoning_content;
    delete additional_kwargs.reasoning_text;
    delete additional_kwargs.reasoning_opaque;
    const clean = new AIMessage({
      ...message,
      content,
      additional_kwargs,
      tool_calls: message.tool_calls,
    });
    if (messageText(clean) || clean.tool_calls?.length) result.push(clean);
  }
  return result;
};

export const prepareMessagesForModel = async (messages: DriverMessage[]): Promise<DriverMessage[]> =>
  await Promise.all(messages.map(async message => {
    if (typeof message.content === 'string') return message;
    let changed = false;
    const content = await Promise.all(message.content.map(async block => {
      if (block.type !== 'image' || !isSharp(block.data)) return block;
      changed = true;
      const buffer = await block.data.toBuffer();
      const metadata = await sharp(buffer).metadata();
      return {
        ...block,
        type: 'image' as const,
        data: new Uint8Array(buffer),
        mimeType: metadata.format ? `image/${metadata.format}` : 'image/png',
      } satisfies ContentBlock.Multimodal.Image;
    }));
    return changed ? cloneMessage(message, content) : message;
  }));

const legacyInputPart = (part: LegacyInputPart): DriverInputBlock =>
  part.kind === 'text' ? textBlock(part.text) : imageBlock(part.image, part.detail);

const legacyOutputContent = (part: LegacyOutputPart): ContentBlock[] => {
  if (part.kind === 'text') return [textBlock(part.text)];
  if (part.kind === 'textGroup') return part.content.map(item => textBlock(item.text));
  if (part.kind === 'toolCall') return [];
  const data = part.data.data;
  if (data.type === 'thinking')
    return [{ type: 'thinking', thinking: data.thinking, ...(data.signature ? { signature: data.signature } : {}) }];
  if (data.type === 'redacted_thinking')
    return [{ type: 'redacted_thinking', data: data.data }];
  return [{
    type: 'non_standard',
    value: { ...data },
  }];
};

export const legacyEntriesToMessages = (entries: LegacyConversationEntry[]): DriverMessage[] =>
  entries.map(entry => {
    if (entry.kind === 'toolResult')
      return toolMessage(
        entry.callId,
        typeof entry.payload === 'string' ? entry.payload : entry.payload.map(legacyInputPart),
        entry.requiresFollowUp,
      );
    if (entry.role === 'user')
      return humanMessage(entry.parts.map(legacyInputPart));
    if (entry.role === 'system')
      return systemMessage(entry.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(''));
    const output = entry as LegacyOutputMessage;
    return new AIMessage({
      content: output.parts.flatMap(legacyOutputContent),
      tool_calls: output.parts.flatMap(part => part.kind === 'toolCall'
        ? [{ id: part.callId, name: part.name, args: JSON.parse(part.args) as Record<string, unknown> }]
        : []),
      additional_kwargs: { ...(output.reasoning ?? {}) },
    });
  });

export const storedMessagesToDriverMessages = (messages: StoredMessage[]): DriverMessage[] =>
  mapStoredMessagesToChatMessages(messages).filter(isDriverMessage);
