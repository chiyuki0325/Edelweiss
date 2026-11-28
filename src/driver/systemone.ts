import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '@guiiai/logg';

import type { SystemOneConfig } from '../config/config';
import type { RenderedContext } from '../rendering/types';

const SYSTEM_ONE_TIMEOUT_MS = 5_000;
const CONTEXT_MESSAGE_LIMIT = 3;
const CONTEXT_TEXT_LIMIT = 2_000;
const writingReviewGate = /[不但仅凭只尚却]|无法|更准确/u;
let defensiveWritingInstructions: string | undefined;
let draftOnlyInstructions: string | undefined;
let uninvitedReplyInstructions: string | undefined;

type WritingReviewQuestion = 'is_defensive_writing' | 'is_uninvited_reply';
export type WritingReview = 'defensive' | 'uninvited' | null;

export const selectWritingReviewContext = (rc: RenderedContext, afterMs: number, replyTo?: string): string => {
  const messages = replyTo != null
    ? rc.filter(seg => seg.messageId === replyTo).slice(-1)
    : rc.filter(seg => seg.messageId != null && !seg.isMyself && seg.receivedAtMs > afterMs).slice(-CONTEXT_MESSAGE_LIMIT);
  return messages.map(seg => seg.content
    .flatMap(piece => piece.type === 'text' ? [piece.text] : [])
    .join('\n').slice(0, CONTEXT_TEXT_LIMIT))
    .filter(Boolean).join('\n');
};

const promptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');
const readInstructions = (file: string) => readFileSync(resolve(promptsDir, file), 'utf-8').trim();

export const createDefensiveWritingDetector = (config: SystemOneConfig, log: Logger) =>
  async (draft: string, context?: string): Promise<WritingReview> => {
    if (!writingReviewGate.test(draft))
      return null;

    try {
      defensiveWritingInstructions ??= readInstructions('defensive-writing.md');
      const instructions = context
        ? `${defensiveWritingInstructions}\n\n${draftOnlyInstructions ??= readInstructions('defensive-writing-context.md')}`
        : defensiveWritingInstructions;
      const questions: Partial<Record<WritingReviewQuestion, { type: 'noul'; instructions: string }>> = {
        is_defensive_writing: {
          type: 'noul',
          instructions,
        },
      };
      if (context) {
        uninvitedReplyInstructions ??= readInstructions('uninvited-reply.md');
        questions.is_uninvited_reply = { type: 'noul', instructions: uninvitedReplyInstructions };
      }
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          state: context ? { context, draft } : draft,
          questions,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(SYSTEM_ONE_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.withFields({ status: response.status }).warn('System One defensive writing request failed');
        return null;
      }

      const result = await response.json() as { answers?: Partial<Record<WritingReviewQuestion, { type?: unknown; noul?: unknown }>> } | null;
      const exceedsThreshold = (key: WritingReviewQuestion) => {
        const answer = result?.answers?.[key];
        const score = answer?.noul;
        if (answer?.type !== 'noul' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
          log.withFields({ question: key }).warn('System One returned an invalid writing review answer');
          return false;
        }
        return score > config.threshold;
      };
      const defensive = exceedsThreshold('is_defensive_writing');
      if (context && exceedsThreshold('is_uninvited_reply'))
        return 'uninvited';
      return defensive ? 'defensive' : null;
    } catch {
      log.warn('System One defensive writing check failed');
      return null;
    }
  };
