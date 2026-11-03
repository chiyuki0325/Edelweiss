import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSendMessageTool } from './send-message';
import type { SendMessageTurnFlags } from './types';
import { detectDongpo } from '../dongpo';

vi.mock('../dongpo', () => ({ detectDongpo: vi.fn() }));

beforeEach(() => vi.mocked(detectDongpo).mockReset().mockResolvedValue(false));

describe('dongpo speech-tic review', () => {
  it('requests a rewrite before sending and flags only once per turn', async () => {
    vi.mocked(detectDongpo).mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send);
    const draft = { text: '仅凭这些还不能断言服务都挂了' };

    const rejected = await tool.execute(draft, { toolCallId: 'review' });
    expect(send).not.toHaveBeenCalled();
    expect(rejected.requiresFollowUp).toBe(true);
    const payload = JSON.parse(rejected.content as string);
    expect(payload).toMatchObject({
      ok: false,
      code: 'dongpo_review_required',
      next_action: { action: 'send_message' },
    });
    expect(payload.next_action.instruction).toContain('GPT');
    expect(payload.next_action.instruction).toContain('保留实质事实');

    const sent = await tool.execute(draft, { toolCallId: 'retry' });
    expect(JSON.parse(sent.content as string)).toEqual({ ok: true, message_id: '42' });
    expect(send).toHaveBeenCalledOnce();
    expect(detectDongpo).toHaveBeenCalledOnce();

    const nextTurn = createSendMessageTool(send);
    const nextRejected = await nextTurn.execute(draft, { toolCallId: 'next-turn' });
    expect(JSON.parse(nextRejected.content as string).code).toBe('dongpo_review_required');
    expect(detectDongpo).toHaveBeenCalledTimes(2);
  });

  it('does not consume the per-turn review when a draft passes', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send);
    await tool.execute({ text: '服务已经恢复了' }, { toolCallId: 'normal' });
    vi.mocked(detectDongpo).mockResolvedValue(true);
    const rejected = await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'review' });
    expect(JSON.parse(rejected.content as string).code).toBe('dongpo_review_required');
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips inference when the toggle is disabled', async () => {
    vi.mocked(detectDongpo).mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const tool = createSendMessageTool(send, undefined, false, true, true, true, false);
    await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'disabled' });
    expect(detectDongpo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips focus mode without consuming the per-turn review', async () => {
    vi.mocked(detectDongpo).mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue({ messageId: '42' });
    const flags: SendMessageTurnFlags = { wasLengthLimited: false, inFocusMode: true };
    const tool = createSendMessageTool(send, flags);
    await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'focus' });
    expect(detectDongpo).not.toHaveBeenCalled();
    flags.inFocusMode = false;
    const rejected = await tool.execute({ text: '但这不能说明一切' }, { toolCallId: 'normal' });
    expect(JSON.parse(rejected.content as string).code).toBe('dongpo_review_required');
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps existing reviews ahead of model inference', async () => {
    const tool = createSendMessageTool(vi.fn());
    const rejected = await tool.execute({ text: '确实，但不能这样说' }, { toolCallId: 'agreement' });
    expect(JSON.parse(rejected.content as string).code).toBe('agreement_review_required');
    expect(detectDongpo).not.toHaveBeenCalled();
  });
});
