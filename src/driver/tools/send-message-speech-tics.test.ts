import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSendMessageTool } from './send-message';
import type { SendMessageTurnFlags } from './types';
import type { WritingReview } from '../systemone';

const detectDefensiveWriting = vi.fn<(text: string, replyTo?: string) => Promise<WritingReview>>();
beforeEach(() => detectDefensiveWriting.mockReset().mockResolvedValue(null));

describe('defensive writing review', () => {
  it('requests a rewrite before sending and flags only once per turn', async () => {
    detectDefensiveWriting.mockResolvedValue('defensive');
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send, undefined, false, true, true, true, { detectDefensiveWriting });
    const draft = { text: '仅凭这些还不能断言服务都挂了' };

    const rejected = await tool.execute(draft, { toolCallId: 'review' });
    expect(send).not.toHaveBeenCalled();
    expect(rejected.requiresFollowUp).toBe(true);
    const payload = JSON.parse(rejected.content as string);
    expect(payload).toMatchObject({
      ok: false,
      code: 'defensive_review_required',
      next_actions: {
        has_new_information: { action: 'send_message' },
        defensive_only: { action: 'stay_silent' },
      },
    });
    expect(payload.next_actions.has_new_information.instruction).toContain('保留你认为有效的信息量');

    const sent = await tool.execute(draft, { toolCallId: 'retry' });
    expect(JSON.parse(sent.content as string)).toEqual({ ok: true, message_id: '42' });
    expect(send).toHaveBeenCalledOnce();
    expect(detectDefensiveWriting).toHaveBeenCalledOnce();

    const nextTurn = createSendMessageTool(send, undefined, false, true, true, true, { detectDefensiveWriting });
    const nextRejected = await nextTurn.execute(draft, { toolCallId: 'next-turn' });
    expect(JSON.parse(nextRejected.content as string).code).toBe('defensive_review_required');
    expect(detectDefensiveWriting).toHaveBeenCalledTimes(2);
  });

  it('does not consume the per-turn review when a draft passes', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send, undefined, false, true, true, true, { detectDefensiveWriting });
    await tool.execute({ text: '服务已经恢复了' }, { toolCallId: 'normal' });
    detectDefensiveWriting.mockResolvedValue('defensive');
    const rejected = await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'review' });
    expect(JSON.parse(rejected.content as string).code).toBe('defensive_review_required');
    expect(send).toHaveBeenCalledOnce();
  });

  it('sends normally without a detector', async () => {
    detectDefensiveWriting.mockResolvedValue('defensive');
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send);
    await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'disabled' });
    expect(detectDefensiveWriting).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips focus mode without consuming the per-turn review', async () => {
    detectDefensiveWriting.mockResolvedValue('defensive');
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const flags: SendMessageTurnFlags = { wasLengthLimited: false, inFocusMode: true };
    const tool = createSendMessageTool(send, flags, false, true, true, true, { detectDefensiveWriting });
    await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'focus' });
    expect(detectDefensiveWriting).not.toHaveBeenCalled();
    flags.inFocusMode = false;
    const rejected = await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'normal' });
    expect(JSON.parse(rejected.content as string).code).toBe('defensive_review_required');
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps existing reviews ahead of model inference', async () => {
    const tool = createSendMessageTool(vi.fn(), undefined, false, true, true, true, { detectDefensiveWriting });
    const rejected = await tool.execute({ text: '确实，但不能这样说' }, { toolCallId: 'agreement' });
    expect(JSON.parse(rejected.content as string).code).toBe('agreement_review_required');
    expect(detectDefensiveWriting).not.toHaveBeenCalled();
  });
});
