import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import { ChatAnthropic } from '@langchain/anthropic';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';

import { DUMP_DIR } from './constants';
import { trimImages } from './context';
import {
  prepareMessagesForModel,
  toolCalls,
  type DriverMessage,
} from './messages';
import { DEFAULT_LOCAL_FORCE_MAX_RETRIES, type ToolChoice } from '../llm/tool-choice';
import type { ProviderFormat, Usage } from '../llm/types';

export interface LlmCallConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  timeoutSec?: number;
  toolChoice?: ToolChoice;
  localForceMaxRetries?: number;
  onToolCallStart?: () => void;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallResult {
  entries: DriverMessage[];
  usage: Usage;
}

const dump = (dumpId: string | undefined, suffix: string, body: unknown) => {
  if (dumpId) writeFileSync(`${DUMP_DIR}/${dumpId}.${suffix}.json`, JSON.stringify(body, null, 2));
};

const toLangChainTools = (schemas: ToolSchema[] | undefined): StructuredToolInterface[] | undefined => {
  if (!schemas?.length) return undefined;
  return schemas.map(schema => tool(
    async () => '',
    {
      name: schema.name,
      description: schema.description ?? `${schema.name} tool`,
      schema: schema.parameters as {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
      },
    },
  ));
};

const usageFromMessage = (message: AIMessage): Usage => {
  const usage = message.usage_metadata;
  const raw = message.response_metadata.usage as Record<string, unknown> | undefined;
  const rawNumber = (key: string): number | undefined =>
    typeof raw?.[key] === 'number' ? raw[key] as number : undefined;
  return {
    inputTokens: usage?.input_tokens ?? rawNumber('prompt_tokens') ?? rawNumber('input_tokens') ?? 0,
    outputTokens: usage?.output_tokens ?? rawNumber('completion_tokens') ?? rawNumber('output_tokens') ?? 0,
    cacheCreationTokens: usage?.input_token_details?.cache_creation
      ?? rawNumber('prompt_cache_miss_tokens')
      ?? rawNumber('cache_creation_input_tokens')
      ?? -1,
    cacheReadTokens: usage?.input_token_details?.cache_read
      ?? rawNumber('prompt_cache_hit_tokens')
      ?? rawNumber('cache_read_input_tokens')
      ?? -1,
  };
};

const toolChoiceFor = (
  format: ProviderFormat,
  policy: ToolChoice | undefined,
): 'required' | 'none' | 'any' | undefined => {
  if (policy === 'force') return format === 'anthropic-messages' ? 'any' : 'required';
  if (policy === 'none') return 'none';
  return undefined;
};

const createModel = (config: LlmCallConfig, policy: ToolChoice | undefined) => {
  const timeout = config.timeoutSec == null ? undefined : config.timeoutSec * 1000;
  if (config.apiFormat === 'anthropic-messages') {
    return new ChatAnthropic({
      model: config.model,
      apiKey: config.apiKey,
      anthropicApiUrl: config.apiBaseUrl,
      maxRetries: 0,
      streamUsage: true,
      clientOptions: { timeout },
      invocationKwargs: {
        ...config.extraBody,
        cache_control: { type: 'ephemeral' },
      },
    });
  }
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    timeout,
    maxRetries: 0,
    streamUsage: true,
    useResponsesApi: config.apiFormat === 'responses',
    configuration: { baseURL: config.apiBaseUrl },
    modelKwargs: {
      ...config.extraBody,
      ...(config.apiFormat === 'responses'
        ? { tool_choice: toolChoiceFor('responses', policy) }
        : {}),
    },
  });
};

const streamModel = async (
  config: LlmCallConfig,
  messages: BaseMessage[],
  tools: StructuredToolInterface[] | undefined,
  policy: ToolChoice | undefined,
): Promise<AIMessage> => {
  const format = config.apiFormat ?? 'openai-chat';
  const model = createModel(config, policy);
  const wireToolChoice = toolChoiceFor(format, policy);
  const runnable = tools?.length
    ? model.bindTools(tools, { tool_choice: wireToolChoice })
    : model.withConfig({ tool_choice: wireToolChoice });
  const stream = await runnable.stream(messages, {
    signal: config.signal,
  });

  let aggregate: AIMessageChunk | undefined;
  let toolCallStarted = false;
  for await (const chunk of stream) {
    const started = Boolean(chunk.tool_call_chunks?.length)
      || Boolean(chunk.tool_calls?.length)
      || (Array.isArray(chunk.content) && chunk.content.some((block: { type: string }) =>
        block.type === 'tool_use' || block.type === 'function_call'));
    if (started && !toolCallStarted) {
      toolCallStarted = true;
      config.onToolCallStart?.();
    }
    aggregate = aggregate ? aggregate.concat(chunk) : chunk;
  }
  if (!aggregate) return new AIMessage('');
  return new AIMessage({
    ...aggregate,
    content: aggregate.content,
    tool_calls: aggregate.tool_calls,
    invalid_tool_calls: aggregate.invalid_tool_calls,
    usage_metadata: aggregate.usage_metadata,
  });
};

const callLlmAttempt = async (
  config: LlmCallConfig,
  entries: DriverMessage[],
  system: string,
  tools?: ToolSchema[],
  options?: { log: Logger; label: string; dumpId?: string; maxImagesAllowed?: number; toolChoice?: ToolChoice },
): Promise<LlmCallResult> => {
  let prepared = entries;
  if (options?.maxImagesAllowed != null)
    prepared = trimImages(prepared, options.maxImagesAllowed);
  prepared = await prepareMessagesForModel(prepared);

  const systemEntry = config.apiFormat === 'anthropic-messages'
    ? new SystemMessage({
      content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    })
    : new SystemMessage(system);
  const messages = [systemEntry, ...prepared];
  const langChainTools = toLangChainTools(tools);
  const policy = options?.toolChoice ?? config.toolChoice;

  dump(options?.dumpId, 'request', {
    model: config.model,
    apiFormat: config.apiFormat ?? 'openai-chat',
    messages: messages.map(message => message.toDict()),
    tools,
    toolChoice: toolChoiceFor(config.apiFormat ?? 'openai-chat', policy),
  });

  const response = await streamModel({ ...config, toolChoice: policy }, messages, langChainTools, policy);
  dump(options?.dumpId, 'response', response.toDict());
  return { entries: [response], usage: usageFromMessage(response) };
};

/** Retry only local tool policies; every attempt owns its cancellation scope. */
export const callLlm = async (
  config: LlmCallConfig,
  entries: DriverMessage[],
  system: string,
  tools?: ToolSchema[],
  options?: Parameters<typeof callLlmAttempt>[4],
): Promise<LlmCallResult> => {
  const policy = options?.toolChoice ?? config.toolChoice;
  const maxRetries = config.localForceMaxRetries ?? DEFAULT_LOCAL_FORCE_MAX_RETRIES;
  let retryEntries = entries;
  let usage: Usage | undefined;
  for (let attempt = 0; ; attempt++) {
    config.signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(config.signal!.reason);
    config.signal?.addEventListener('abort', onAbort, { once: true });
    const rejection = new Error('local-none: tool call rejected');
    try {
      const result = await callLlmAttempt({
        ...config,
        toolChoice: policy,
        signal: controller.signal,
        onToolCallStart: policy === 'local-none' ? () => {
          controller.abort(rejection);
          throw rejection;
        } : undefined,
      }, retryEntries, system, tools, options);
      config.signal?.throwIfAborted();
      const add = (a: number, b: number) => a === -1 || b === -1 ? -1 : a + b;
      usage = usage ? {
        inputTokens: add(usage.inputTokens, result.usage.inputTokens),
        outputTokens: add(usage.outputTokens, result.usage.outputTokens),
        cacheCreationTokens: add(usage.cacheCreationTokens, result.usage.cacheCreationTokens),
        cacheReadTokens: add(usage.cacheReadTokens, result.usage.cacheReadTokens),
      } : result.usage;
      if (policy !== 'local-force' || toolCalls(result.entries).length > 0 || attempt >= maxRetries)
        return { ...result, usage };
      options?.log.withFields({ label: options.label, attempt: attempt + 1, maxRetries })
        .log('local-force: model returned no tool calls, retrying');
    } catch (error) {
      config.signal?.throwIfAborted();
      if (error !== rejection && !(error instanceof Error && error.cause === rejection)) throw error;
      retryEntries = [...retryEntries, new HumanMessage('DO NOT CALL ANY TOOLS.')];
      options?.log.withFields({ label: options.label, attempt: attempt + 1 })
        .log('local-none: tool call rejected, retrying; usage incomplete (aborted attempt usage unavailable)');
    } finally {
      config.signal?.removeEventListener('abort', onAbort);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    config.signal?.throwIfAborted();
  }
};
