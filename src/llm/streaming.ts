import type { Logger } from '@guiiai/logg';

import { parseSSEStream } from './sse';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';

// Chat Completions SSE chunk shape (subset we consume)
interface ChatStreamChunk {
  usage?: ChatStreamUsage;
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      content?: string;
      reasoning_text?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_opaque?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface ChatStreamUsage extends Partial<Omit<ChatUsage, 'prompt_tokens_details'>> {
  prompt_tokens_details?: ChatUsage['prompt_tokens_details'];
}

// Tool schema for API serialization — only the fields sent over the wire.
interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface StreamingChatParams {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  system?: string;
  tools?: ToolSchema[];
  forceToolCall?: boolean | 'api' | 'local';
  timeoutSec?: number;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  log: Logger;
  label: string; // log prefix, e.g. "step" or "compact"
}

export interface StreamingChatResult {
  choices: Array<{ finish_reason: string; message: ChatCompletionsAssistantMessage }>;
  usage: ChatUsage;
}

// Parse an OpenAI-compatible SSE stream into a single ChatCompletion-shaped result.
// Logs every content/reasoning/tool_call delta as it arrives.
export const streamingChat = async (params: StreamingChatParams): Promise<StreamingChatResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`chat request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;
  // If external signal triggers, abort the request
  if (params.signal) {
    if (params.signal.aborted) {
      abortController.abort(new Error('Request aborted before start'));
    } else {
      params.signal.addEventListener('abort', () => abortController.abort(params.signal!.reason), { once: true });
    }
  }

  try {
    const body = JSON.stringify({
      model: params.model,
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        ...params.messages,
      ],
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.forceToolCall === true || params.forceToolCall === 'api' ? { tool_choice: 'required' } : {}),
      ...(params.extraBody ?? {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    const url = `${params.baseURL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chat Completions API ${res.status}: ${text}`);
    }

    const stream = res.body;
    if (!stream) throw new Error('SSE response has no body');

    // Accumulated state for the single choice we care about
    let finishReason = '';
    const message: ChatCompletionsAssistantMessage = { role: 'assistant' };
    let usage: ChatUsage = { prompt_tokens: 0, completion_tokens: 0 };

    // Accumulators for logging batched deltas
    let textBuf = '';
    let reasoningBuf = '';

    const flushTextBuf = () => {
      if (textBuf) {
        log.withFields({ label, text: textBuf }).log('content delta');
        textBuf = '';
      }
    };

    const flushReasoningBuf = () => {
      if (reasoningBuf) {
        log.withFields({ label, reasoning: reasoningBuf }).log('reasoning delta');
        reasoningBuf = '';
      }
    };

    const processChunk = (chunk: ChatStreamChunk) => {
      // Usage (comes in the final chunk when streamOptions.includeUsage is true)
      if (chunk.usage) {
        const nextUsage: ChatUsage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens ?? usage.completion_tokens,
        };
        const promptTokensDetails = chunk.usage.prompt_tokens_details ?? usage.prompt_tokens_details;
        if (promptTokensDetails)
          nextUsage.prompt_tokens_details = promptTokensDetails;
        const promptCacheHitTokens = chunk.usage.prompt_cache_hit_tokens ?? usage.prompt_cache_hit_tokens;
        if (promptCacheHitTokens != null)
          nextUsage.prompt_cache_hit_tokens = promptCacheHitTokens;
        const promptCacheMissTokens = chunk.usage.prompt_cache_miss_tokens ?? usage.prompt_cache_miss_tokens;
        if (promptCacheMissTokens != null)
          nextUsage.prompt_cache_miss_tokens = promptCacheMissTokens;
        usage = nextUsage;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) return;

      if (choice.finish_reason)
        finishReason = choice.finish_reason;

      // Content text
      if (delta.content) {
        textBuf += delta.content;
        message.content ??= '';
        message.content += delta.content;
      }

      // Reasoning — different providers use different delta field names:
      //   reasoning_text + reasoning_opaque: Anthropic compat (text + signature)
      //   reasoning_content: DeepSeek, xAI, Qwen
      //   reasoning: vLLM, Groq, OpenRouter
      // All are accumulated as-is into the message object and persisted raw.
      // sanitizeReasoningForTR strips them on compat mismatch via whitelist.
      if (delta.reasoning_text) {
        reasoningBuf += delta.reasoning_text;
        message.reasoning_text ??= '';
        message.reasoning_text += delta.reasoning_text;
      }
      if (delta.reasoning_content) {
        reasoningBuf += delta.reasoning_content;
        message.reasoning_content ??= '';
        message.reasoning_content += delta.reasoning_content;
      }
      if (delta.reasoning) {
        reasoningBuf += delta.reasoning;
        message.reasoning ??= '';
        message.reasoning += delta.reasoning;
      }

      // Reasoning opaque signature (comes as a single chunk)
      if (delta.reasoning_opaque) {
        message.reasoning_opaque = (message.reasoning_opaque ?? '') + delta.reasoning_opaque;
      }

      // Tool calls — accumulate incrementally
      if (delta.tool_calls) {
        message.tool_calls ??= [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          message.tool_calls[idx] ??= {
            id: tc.id ?? '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          const existing = message.tool_calls[idx];
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) {
            flushTextBuf();
            flushReasoningBuf();
            existing.function.name += tc.function.name;
            log.withFields({ label, tool: existing.function.name }).log('tool call start');
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
        }
      }
    };

    await parseSSEStream(stream, processChunk);
    flushTextBuf();
    flushReasoningBuf();

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let args: unknown = tc.function.arguments;
        try { args = JSON.parse(tc.function.arguments); } catch { /* keep raw string */ }
        log.withFields({ label, tool: tc.function.name, args }).log('tool call');
      }
    }

    return {
      choices: [{ finish_reason: finishReason, message }],
      usage,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
