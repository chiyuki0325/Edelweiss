import type { Logger } from '@guiiai/logg';

import type { AnthropicAssistantContentBlock, AnthropicCacheControl, AnthropicMessage, AnthropicSystemBlock, AnthropicTool, AnthropicToolUseBlock, AnthropicUserContentBlock } from './anthropic-types';
import { parseSSEStream } from './sse';
import type { ThinkingConfig } from './types';

interface AnthropicSSEEvent {
  type: string;
  [key: string]: unknown;
}

export interface StreamingAnthropicParams {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  maxTokens?: number;
  timeoutSec?: number;
  thinking?: ThinkingConfig;
  log: Logger;
  label: string;
}

export interface StreamingAnthropicResult {
  content: AnthropicAssistantContentBlock[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

const DEFAULT_MAX_TOKENS = 8096;
const THINKING_BUDGET_HIGH = 5000;
const THINKING_BUDGET_MAX = 10000;

const buildThinkingParam = (thinking?: ThinkingConfig) => {
  if (!thinking || thinking.type === 'disabled') return undefined;
  const budgetTokens = thinking.effort === 'max' ? THINKING_BUDGET_MAX : THINKING_BUDGET_HIGH;
  return { type: 'enabled', budget_tokens: budgetTokens };
};

const CACHE_MARK: AnthropicCacheControl = { type: 'ephemeral' };

// Inject prompt-caching breakpoints for KV cache efficiency.
//
// Placement strategy (3 breakpoints, all within the 4-breakpoint API limit):
//   1. System block     — static every turn, largest single-shot win
//   2. Last tool        — tool set is identical every turn
//   3. messages[-2]     — everything before the late-binding prompt (messages[-1])
//                         is stable history; caching here means next turn hits the
//                         full history including this turn's new RC messages.
//
// messages[-1] is the late-binding user message injected by the Driver (current time,
// mention/reply state, etc.) — it changes every call and is never cached.
const injectCacheControl = (
  system: string | undefined,
  tools: AnthropicTool[],
  messages: AnthropicMessage[],
): {
  systemBlocks: AnthropicSystemBlock[] | undefined;
  tools: AnthropicTool[];
  messages: AnthropicMessage[];
} => {
  // 1. System as array with cache_control
  const systemBlocks: AnthropicSystemBlock[] | undefined = system
    ? [{ type: 'text', text: system, cache_control: CACHE_MARK }]
    : undefined;

  // 2. Last tool with cache_control (clone array + last element)
  const cachedTools = tools.length > 0
    ? [
        ...tools.slice(0, -1),
        { ...tools[tools.length - 1]!, cache_control: CACHE_MARK },
      ]
    : tools;

  // 3. messages[-2] last content block with cache_control
  if (messages.length < 2)
    return { systemBlocks, tools: cachedTools, messages };

  const targetIdx = messages.length - 2;
  const target = messages[targetIdx]!;

  let markedTarget: AnthropicMessage;
  if (typeof target.content === 'string') {
    // Wrap bare string in a content block array so we can attach cache_control
    markedTarget = {
      ...target,
      content: [{ type: 'text', text: target.content, cache_control: CACHE_MARK }],
    } as AnthropicMessage;
  } else if (Array.isArray(target.content) && target.content.length > 0) {
    const arr = target.content as AnthropicUserContentBlock[];
    const last = arr[arr.length - 1]!;
    const markedArr: AnthropicUserContentBlock[] = [
      ...arr.slice(0, -1),
      { ...last, cache_control: CACHE_MARK } as AnthropicUserContentBlock,
    ];
    markedTarget = { ...target, content: markedArr } as AnthropicMessage;
  } else {
    return { systemBlocks, tools: cachedTools, messages };
  }

  const cachedMessages = [...messages];
  cachedMessages[targetIdx] = markedTarget;
  return { systemBlocks, tools: cachedTools, messages: cachedMessages };
};

// Parse an Anthropic Messages API SSE stream into a StreamingAnthropicResult.
// Logs every content/reasoning/tool_call delta as it arrives.
export const streamingAnthropic = async (params: StreamingAnthropicParams): Promise<StreamingAnthropicResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`anthropic request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const thinkingParam = buildThinkingParam(params.thinking);
    const maxTokens = params.maxTokens
      ?? (thinkingParam ? thinkingParam.budget_tokens + 4096 : DEFAULT_MAX_TOKENS);

    const {
      systemBlocks,
      tools: cachedTools,
      messages: cachedMessages,
    } = injectCacheControl(params.system, params.tools ?? [], params.messages);

    const body = JSON.stringify({
      model: params.model,
      max_tokens: maxTokens,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      messages: cachedMessages,
      ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      ...(thinkingParam ? { thinking: thinkingParam } : {}),
      stream: true,
    });

    const url = `${params.baseURL.replace(/\/$/, '')}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic Messages API ${res.status}: ${text}`);
    }

    const stream = res.body;
    if (!stream) throw new Error('SSE response has no body');

    const blocks: AnthropicAssistantContentBlock[] = [];
    // Accumulate raw JSON strings for tool_use inputs before parsing
    const toolInputAccumulator = new Map<number, string>();
    let stopReason = '';
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: undefined as number | undefined,
      cacheCreationTokens: undefined as number | undefined,
    };

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

    const processEvent = (event: AnthropicSSEEvent) => {
      switch (event.type) {
      case 'message_start': {
        const msg = event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
        if (msg?.usage) {
          usage.inputTokens = msg.usage.input_tokens ?? 0;
          if (msg.usage.cache_read_input_tokens != null) usage.cacheReadTokens = msg.usage.cache_read_input_tokens;
          if (msg.usage.cache_creation_input_tokens != null) usage.cacheCreationTokens = msg.usage.cache_creation_input_tokens;
        }
        break;
      }

      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as { type: string; text?: string; id?: string; name?: string; thinking?: string; data?: string };

        if (block.type === 'text') {
          blocks[index] = { type: 'text', text: block.text ?? '' };
        } else if (block.type === 'tool_use') {
          flushTextBuf();
          flushReasoningBuf();
          log.withFields({ label, tool: block.name }).log('tool call start');
          blocks[index] = { type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: {} };
          toolInputAccumulator.set(index, '');
        } else if (block.type === 'thinking') {
          blocks[index] = { type: 'thinking', thinking: block.thinking ?? '' };
        } else if (block.type === 'redacted_thinking') {
          blocks[index] = { type: 'redacted_thinking', data: block.data ?? '' };
        }
        break;
      }

      case 'content_block_delta': {
        const index = event.index as number;
        const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
        const block = blocks[index];
        if (!block) break;

        if (delta.type === 'text_delta' && delta.text && block.type === 'text') {
          textBuf += delta.text;
          block.text += delta.text;
        } else if (delta.type === 'input_json_delta' && delta.partial_json && block.type === 'tool_use') {
          toolInputAccumulator.set(index, (toolInputAccumulator.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && delta.thinking && block.type === 'thinking') {
          reasoningBuf += delta.thinking;
          block.thinking += delta.thinking;
        } else if (delta.type === 'signature_delta' && delta.signature && block.type === 'redacted_thinking') {
          // signature_delta replaces (not appends) the data field
          block.data = delta.signature;
        }
        break;
      }

      case 'content_block_stop': {
        const index = event.index as number;
        const block = blocks[index];
        if (!block) break;

        if (block.type === 'tool_use') {
          const rawInput = toolInputAccumulator.get(index) ?? '';
          toolInputAccumulator.delete(index);
          if (rawInput) {
            try { (block as AnthropicToolUseBlock).input = JSON.parse(rawInput); } catch { /* keep empty input */ }
          }
        }
        break;
      }

      case 'message_delta': {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        const u = event.usage as { output_tokens?: number } | undefined;
        if (u?.output_tokens != null) usage.outputTokens = u.output_tokens;
        break;
      }

      case 'error': {
        const err = event.error as { type?: string; message?: string } | undefined;
        log.withFields({ label, error: err?.message }).error('Anthropic stream error');
        break;
      }

      default:
        break;
      }
    };

    await parseSSEStream(stream, processEvent);
    flushTextBuf();
    flushReasoningBuf();

    if (usage.cacheReadTokens != null || usage.cacheCreationTokens != null) {
      log.withFields({
        label,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        inputTokens: usage.inputTokens,
      }).log('cache usage');
    }

    return { content: blocks.filter(b => b != null), stopReason, usage };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
