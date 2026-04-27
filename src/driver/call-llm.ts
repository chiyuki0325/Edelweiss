import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { trimImages } from './context';
import { DUMP_DIR } from './constants';
import { streamingChat } from './streaming';
import { streamingMessages } from './streaming-messages';
import { streamingResponses } from './streaming-responses';
import type { ProviderFormat, Usage } from './types';
import {
  fromChatCompletionsOutput,
  fromMessagesOutput,
  fromResponsesOutput,
  toChatCompletionsInput,
  toMessagesInput,
  toResponsesInput,
} from '../unified-api';
import type { MessagesSystemBlock } from '../unified-api/anthropic-types';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';
import type { ResponsesAssistantItem } from '../unified-api/responses-types';
import type { ConversationEntry } from '../unified-api/types';

export interface LlmCallConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  timeoutSec?: number;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallResult {
  entries: ConversationEntry[];
  usage: Usage;
}

const dump = (dumpId: string | undefined, suffix: string, body: unknown) => {
  if (dumpId) writeFileSync(`${DUMP_DIR}/${dumpId}.${suffix}.json`, JSON.stringify(body, null, 2));
};

const toResponsesToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  name: t.name,
  parameters: t.parameters,
  strict: false,
  ...(t.description ? { description: t.description } : {}),
});

const toAnthropicToolSchema = (t: ToolSchema) => ({
  name: t.name,
  ...(t.description ? { description: t.description } : {}),
  input_schema: t.parameters,
});

const toChatToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
  },
});

const optionalTools = <T>(mapped: T[] | undefined): T[] | undefined =>
  mapped && mapped.length > 0 ? mapped : undefined;

export const callLlm = async (
  config: LlmCallConfig,
  entries: ConversationEntry[],
  system: string,
  tools?: ToolSchema[],
  options?: { log: Logger; label: string; dumpId?: string; maxImagesAllowed?: number },
): Promise<LlmCallResult> => {
  const apiFormat: ProviderFormat = config.apiFormat ?? 'openai-chat';
  const log = options?.log;
  const label = options?.label ?? '';

  let prepared = entries;
  if (options?.maxImagesAllowed != null)
    prepared = trimImages(prepared, options.maxImagesAllowed);

  if (apiFormat === 'responses') {
    const input = await toResponsesInput(prepared);
    const wireTools = optionalTools(tools?.map(toResponsesToolSchema));
    dump(options?.dumpId, 'request', { model: config.model, instructions: system, input, tools: wireTools });

    const response = await streamingResponses({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      input, instructions: system, ...(wireTools ? { tools: wireTools } : {}),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    const assistantItems = (response.output as unknown as ResponsesAssistantItem[]).filter(item =>
      item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning');
    return {
      entries: fromResponsesOutput(assistantItems),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // not supported for openai format
        cacheCreationTokens: -1,
        cacheReadTokens: -1,
      },
    };
  }

  if (apiFormat === 'anthropic-messages') {
    const { system: sysFromEntries, messages } = await toMessagesInput(prepared);
    const effectiveSystem = sysFromEntries ?? system;
    const wireTools = optionalTools(tools?.map(toAnthropicToolSchema));

    // Prompt cache breakpoints: system, last tool, messages[-2]
    const cachedSystem: MessagesSystemBlock[] | undefined = effectiveSystem
      ? [{ type: 'text', text: effectiveSystem, cache_control: { type: 'ephemeral' } }]
      : undefined;

    if (wireTools && wireTools.length > 0)
      (wireTools[wireTools.length - 1]! as Record<string, unknown>).cache_control = { type: 'ephemeral' };

    // Walk backward from messages[-2] to find the last block that accepts cache_control.
    // thinking/redacted_thinking blocks do not support it and will cause a 400 error.
    const startIdx = messages.length >= 2 ? messages.length - 2 : messages.length - 1;
    outer: for (let mi = startIdx; mi >= 0; mi--) {
      const msg = messages[mi]!;
      if (typeof msg.content === 'string') {
        (msg as unknown as Record<string, unknown>).content = [
          { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
        ];
        break;
      }
      for (let bi = msg.content.length - 1; bi >= 0; bi--) {
        const block = msg.content[bi]!;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
        (block as Record<string, unknown>).cache_control = { type: 'ephemeral' };
        break outer;
      }
    }

    dump(options?.dumpId, 'request', { model: config.model, system: cachedSystem, messages, tools: wireTools });

    const response = await streamingMessages({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      system: cachedSystem, messages, ...(wireTools ? { tools: wireTools } : {}),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    return {
      entries: fromMessagesOutput(response.content),
      usage: {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? -1,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? -1,
      },
    };
  }

  // openai-chat (default)
  const chatMessages = await toChatCompletionsInput(prepared);
  const wireTools = optionalTools(tools?.map(toChatToolSchema));
  dump(options?.dumpId, 'request', { model: config.model, system, messages: chatMessages, tools: wireTools });

  const response = await streamingChat({
    baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
    messages: chatMessages, system, ...(wireTools ? { tools: wireTools } : {}),
    log: log!, label, timeoutSec: config.timeoutSec,
  });
  dump(options?.dumpId, 'response', response);

  const choice = response.choices[0];
  if (!choice) return {
    entries: [], usage: {
      inputTokens: response.usage.prompt_tokens ?? 0,
      outputTokens: response.usage.completion_tokens ?? 0,
      cacheCreationTokens: -1,
      cacheReadTokens: -1,
    }
  };

  return {
    entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
    usage: {
      inputTokens: response.usage.prompt_tokens ?? 0,
      outputTokens: response.usage.completion_tokens ?? 0,
      cacheCreationTokens: -1,
      cacheReadTokens: -1,
    }
  };
};
