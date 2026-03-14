import type { Message } from 'xsai';

import { mergeContext } from './merge';
import type { TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

type AnyMsg = Record<string, any>;
const asMsg = (m: Message): AnyMsg => m as unknown as AnyMsg;

// ~2 chars per token for mixed CJK/English/XML.
// For images, use actual base64 URL length (dominates HTTP payload).
const CHARS_PER_TOKEN = 2;

const estimatePartTokens = (part: Record<string, any>): number => {
  if (part.type === 'image_url' && part.image_url?.url)
    return Math.ceil((part.image_url.url as string).length / CHARS_PER_TOKEN);
  return Math.ceil(((part.text as string)?.length ?? 0) / CHARS_PER_TOKEN);
};

const estimateMessageTokens = (m: AnyMsg): number => {
  if (Array.isArray(m.content))
    return (m.content as AnyMsg[]).reduce((a, p) => a + estimatePartTokens(p), 0);
  if (typeof m.content === 'string')
    return Math.ceil(m.content.length / CHARS_PER_TOKEN);
  return Math.ceil(JSON.stringify(m).length / CHARS_PER_TOKEN);
};

// Trim merged messages to fit within a token budget.
// Drops from the front (oldest first). For user messages, trims individual
// content parts; for assistant/tool messages, drops entire messages.
// Preserves tool_call -> tool_result adjacency.
const trimContext = (messages: Message[], maxTokens: number): { messages: Message[]; estimatedTokens: number } => {
  let totalTokens = messages.reduce((acc, msg) => acc + estimateMessageTokens(asMsg(msg)), 0);

  if (totalTokens <= maxTokens) return { messages, estimatedTokens: totalTokens };

  // Deep-clone user messages' content arrays for mutation
  const result = messages.map(msg =>
    asMsg(msg).role === 'user' && Array.isArray(asMsg(msg).content)
      ? { ...msg, content: [...asMsg(msg).content] }
      : msg) as Message[];

  while (totalTokens > maxTokens) {
    const first = asMsg(result[0]!);

    if (first.role === 'user' && Array.isArray(first.content) && first.content.length > 0) {
      // Keep at least the last content part of the last message
      if (first.content.length <= 1 && result.length <= 1) break;

      const dropped = first.content.shift() as AnyMsg;
      totalTokens -= estimatePartTokens(dropped);

      // User message emptied — remove it
      if (first.content.length === 0) result.shift();
    } else if (result.length > 1) {
      const dropped = asMsg(result.shift()!);
      totalTokens -= estimateMessageTokens(dropped);

      // If dropped an assistant with tool_calls, also drop following tool results
      if (dropped.tool_calls) {
        while (result.length > 0 && asMsg(result[0]!).role === 'tool') {
          totalTokens -= estimateMessageTokens(asMsg(result.shift()!));
        }
      }
    } else {
      break;
    }
  }

  // Don't start with orphaned tool results
  while (result.length > 1 && asMsg(result[0]!).role === 'tool')
    result.shift();

  return { messages: result, estimatedTokens: totalTokens };
};

// Sanitize reasoning from historical TRs before merging into LLM context.
//
// Anthropic models return reasoning as thinking text + cryptographic signature.
// The signature validates that the thinking text hasn't been tampered with;
// replaying requires BOTH — signature alone is useless without the text it signs.
//
// In OpenAI Chat Completions compatible format, this pair appears as:
//   - reasoning_text  (the thinking text)     + reasoning_opaque (the signature)
// In Anthropic native content-array format:
//   - thinking block with `thinking` field    + `signature` field
//
// Signatures are only valid within the same provider family (e.g. "anthropic").
// Each TR records which compat group produced it. On replay:
//   - Same compat group  -> keep all reasoning (signature valid, model can resume)
//   - Different / empty  -> strip all reasoning (signature invalid, would error)
//
// The pair is always kept or stripped together — never one without the other.
const sanitizeReasoningForTR = (tr: TurnResponse, currentCompat: string | undefined): unknown[] =>
  tr.data.map(entry => {
    const m = entry as AnyMsg;
    if (m.role !== 'assistant') return entry;

    const compatMatch = !!currentCompat && !!tr.reasoningSignatureCompat && tr.reasoningSignatureCompat === currentCompat;
    if (compatMatch) return entry;

    // Compat mismatch — strip all reasoning
    let result = { ...m };
    if ('reasoning_text' in result)
      delete result.reasoning_text;
    if ('reasoning_opaque' in result)
      delete result.reasoning_opaque;

    // Strip thinking blocks from content array
    if (Array.isArray(result.content)) {
      const filtered = (result.content as AnyMsg[]).filter(part => part.type !== 'thinking');
      if (filtered.length !== result.content.length)
        result = { ...result, content: filtered.length > 0 ? filtered : '' };
    }

    return result;
  });

// Returns the receivedAtMs of the latest external message after afterMs,
// or null if there are none. Replaces hasNewExternalMessages — one function
// answers both "any new?" (!= null) and "when was the latest?" (the value).
export const latestExternalEventMs = (
  rc: RenderedContext,
  afterMs: number,
): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself)
      latest = seg.receivedAtMs > (latest ?? 0) ? seg.receivedAtMs : latest;
  }
  return latest;
};

export const composeContext = (
  rc: RenderedContext,
  trs: TurnResponse[],
  maxTokens: number,
  reasoningSignatureCompat: string | undefined,
): { messages: Message[]; estimatedTokens: number } | null => {
  const sanitizedTRs = trs.map(tr => ({
    ...tr,
    data: sanitizeReasoningForTR(tr, reasoningSignatureCompat),
  }));

  const allMessages = mergeContext(rc, sanitizedTRs);
  if (allMessages.length === 0) return null;

  return trimContext(allMessages, maxTokens);
};
