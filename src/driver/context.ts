import type { ToolMessage } from '@langchain/core/messages';
import { HumanMessage, isAIMessage, isToolMessage } from '@langchain/core/messages';

import { mergeContext } from './merge';
import {
  cloneMessage,
  humanMessage,
  messageBlocks,
  messageText,
  textBlock,
  toolResultRequiresFollowUp,
  withoutReasoning,
  type DriverImageBlock,
  type DriverInputBlock,
  type DriverMessage,
} from './messages';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';

const CHARS_PER_TOKEN = 2;
const IMAGE_TOKENS = 100;

const blockTokens = (block: { type: string; text?: unknown }): number =>
  block.type === 'image'
    ? IMAGE_TOKENS
    : typeof block.text === 'string'
      ? Math.ceil(block.text.length / CHARS_PER_TOKEN)
      : 20;

const entryTokens = (message: DriverMessage): number => {
  let tokens = messageBlocks(message).reduce((sum, block) => sum + blockTokens(block), 0);
  if (isAIMessage(message)) {
    for (const call of message.tool_calls ?? [])
      tokens += Math.ceil((call.name.length + JSON.stringify(call.args).length) / CHARS_PER_TOKEN);
  }
  return tokens;
};

export const latestExternalEventMs = (rc: RenderedContext, afterMs: number): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself && !seg.isPassiveEvent)
      latest = seg.receivedAtMs > (latest ?? 0) ? seg.receivedAtMs : latest;
  }
  return latest;
};

export const latestInterruptingExternalEventMs = (rc: RenderedContext, afterMs: number): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself && !seg.isRuntimeEvent && !seg.isPassiveEvent)
      latest = seg.receivedAtMs > (latest ?? 0) ? seg.receivedAtMs : latest;
  }
  return latest;
};

const trHasToolCalls = (tr: TurnResponseV2): boolean =>
  tr.entries.some(entry => isAIMessage(entry) && Boolean(entry.tool_calls?.length));

export const wasToolLoopInterrupted = (trs: TurnResponseV2[]): boolean => {
  const last = trs.at(-1);
  return last?.entries.some(entry => isToolMessage(entry) && toolResultRequiresFollowUp(entry)) ?? false;
};

const KEEP_NO_TOOL_CALL_TRS = 5;

const trimStaleNoToolCallTRs = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const noToolIndices: number[] = [];
  for (let i = 0; i < trs.length; i++)
    if (!trHasToolCalls(trs[i]!)) noToolIndices.push(i);
  if (noToolIndices.length <= KEEP_NO_TOOL_CALL_TRS) return trs;
  const dropSet = new Set(noToolIndices.slice(0, -KEEP_NO_TOOL_CALL_TRS));
  return trs.filter((_, index) => !dropSet.has(index));
};

const TOOL_RESULT_TRIM_THRESHOLD = 512;
const TOOL_RESULT_KEEP_RECENT_OVERSIZED = 5;

const trimLongText = (text: string): string => {
  if (text.length <= TOOL_RESULT_TRIM_THRESHOLD) return text;
  let prefix = text.slice(0, 200);
  if (prefix.length > 0 && (prefix.charCodeAt(prefix.length - 1) & 0xFC00) === 0xD800)
    prefix = prefix.slice(0, -1);
  let suffix = text.slice(-200);
  if (suffix.length > 0 && (suffix.charCodeAt(0) & 0xFC00) === 0xDC00)
    suffix = suffix.slice(1);
  return `${prefix}\n... [trimmed ${text.length} chars] ...\n${suffix}`;
};

const toolResultExceedsLimit = (message: ToolMessage): boolean =>
  messageText(message).length > TOOL_RESULT_TRIM_THRESHOLD
  || messageBlocks(message).some(block =>
    block.type === 'image'
    && (block as unknown as DriverImageBlock).metadata?.detail !== 'low');

const trimToolResult = (message: ToolMessage): ToolMessage => {
  if (typeof message.content === 'string')
    return cloneMessage(message, trimLongText(message.content)) as ToolMessage;
  const joined = messageText(message);
  const shouldTrimText = joined.length > TOOL_RESULT_TRIM_THRESHOLD;
  let emitted = false;
  const content = message.content.flatMap(block => {
    if (block.type === 'image') {
      return [{
        ...block,
        metadata: { ...(block.metadata as Record<string, unknown> | undefined), detail: 'low' },
      }];
    }
    if (!shouldTrimText) return [block];
    if (block.type !== 'text' || emitted) return [];
    emitted = true;
    return [textBlock(trimLongText(joined))];
  });
  return cloneMessage(message, content) as ToolMessage;
};

const trimToolResults = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const positions: Array<{ trIndex: number; entryIndex: number }> = [];
  for (const [trIndex, tr] of trs.entries()) {
    for (const [entryIndex, entry] of tr.entries.entries())
      if (isToolMessage(entry) && toolResultExceedsLimit(entry))
        positions.push({ trIndex, entryIndex });
  }
  if (positions.length <= TOOL_RESULT_KEEP_RECENT_OVERSIZED) return trs;
  const toTrim = new Map<number, Set<number>>();
  for (const { trIndex, entryIndex } of positions.slice(0, -TOOL_RESULT_KEEP_RECENT_OVERSIZED)) {
    const set = toTrim.get(trIndex) ?? new Set<number>();
    set.add(entryIndex);
    toTrim.set(trIndex, set);
  }
  return trs.map((tr, trIndex) => ({
    ...tr,
    entries: tr.entries.map((entry, entryIndex) =>
      isToolMessage(entry) && toTrim.get(trIndex)?.has(entryIndex)
        ? trimToolResult(entry)
        : entry),
  }));
};

const filterSelfSentSegments = (rc: RenderedContext): RenderedContext =>
  rc.filter(seg => !seg.isSelfSent);

export const findWorkingWindowCursor = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  budgetTokens: number,
): number => {
  const entries: Array<{ timeMs: number; tokens: number }> = [];
  for (const seg of rc) {
    const tokens = seg.content.reduce((sum, piece) =>
      sum + (piece.type === 'text' ? Math.ceil(piece.text.length / CHARS_PER_TOKEN) : IMAGE_TOKENS), 0);
    entries.push({ timeMs: seg.receivedAtMs, tokens });
  }
  for (const tr of trs)
    entries.push({ timeMs: tr.requestedAtMs, tokens: tr.entries.reduce((sum, entry) => sum + entryTokens(entry), 0) });
  entries.sort((a, b) => b.timeMs - a.timeMs);
  let accumulated = 0;
  for (const entry of entries) {
    accumulated += entry.tokens;
    if (accumulated > budgetTokens) return entry.timeMs;
  }
  return entries.at(-1)?.timeMs ?? 0;
};

const trimEntries = (
  entries: DriverMessage[],
  maxTokens: number,
): { entries: DriverMessage[]; estimatedTokens: number } => {
  let total = entries.reduce((sum, entry) => sum + entryTokens(entry), 0);
  if (total <= maxTokens) return { entries, estimatedTokens: total };
  const result = [...entries];
  while (total > maxTokens && result.length > 1) {
    const dropped = result.shift()!;
    total -= entryTokens(dropped);
    if (isAIMessage(dropped) && dropped.tool_calls?.length) {
      while (result.length > 0 && isToolMessage(result[0]!))
        total -= entryTokens(result.shift()!);
    }
  }
  while (result.length > 1 && isToolMessage(result[0]!))
    total -= entryTokens(result.shift()!);
  return { entries: result, estimatedTokens: total };
};

export const composeContext = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  maxTokens: number,
  currentModelName: string,
  compactSummary?: string,
): { entries: DriverMessage[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  const effectiveRC = filterSelfSentSegments(rc);
  let sanitizedTRs = trs.map(tr =>
    tr.modelName === currentModelName
      ? tr
      : { ...tr, entries: withoutReasoning(tr.entries) });
  sanitizedTRs = trimStaleNoToolCallTRs(sanitizedTRs);
  sanitizedTRs = trimToolResults(sanitizedTRs);

  const merged = mergeContext(effectiveRC, sanitizedTRs);
  if (merged.length === 0 && !compactSummary) return null;
  const entries = compactSummary
    ? [humanMessage(`[Conversation summary]\n${compactSummary}`), ...merged]
    : merged;
  const cleaned = entries.filter(entry =>
    !isAIMessage(entry) || Boolean(messageText(entry) || entry.tool_calls?.length));
  const rawEstimatedTokens = cleaned.reduce((sum, entry) => sum + entryTokens(entry), 0);
  return { ...trimEntries(cleaned, maxTokens), rawEstimatedTokens };
};

export const injectLateBindingPrompt = (entries: DriverMessage[], prompt: string): void => {
  entries.push(new HumanMessage(prompt));
};

const countImages = (entries: DriverMessage[]): number =>
  entries.reduce((count, entry) =>
    count + messageBlocks(entry).filter(block => block.type === 'image').length, 0);

export const trimImages = (entries: DriverMessage[], maxImages: number): DriverMessage[] => {
  const total = countImages(entries);
  if (total <= maxImages) return entries;
  let toDrop = total - maxImages;
  return entries.map(entry => {
    if (toDrop <= 0 || isAIMessage(entry)) return entry;
    const blocks: DriverInputBlock[] = [];
    for (const block of messageBlocks(entry)) {
      if (block.type === 'image' && toDrop > 0) {
        toDrop--;
        continue;
      }
      blocks.push(block as DriverInputBlock);
    }
    const content = blocks.length > 0 ? blocks : [textBlock('[image removed]')];
    return cloneMessage(entry, content);
  });
};

export type { DriverInputBlock, DriverMessage };
