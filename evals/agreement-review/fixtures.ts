import type { TurnResponseV2 } from '../../src/driver/types';
import type { EvalFixture } from '../../src/evals';

const reviewResult = (replyTo: string) => JSON.stringify({
  ok: false,
  code: 'agreement_review_required',
  error: 'The draft contains “确实” and needs a semantic review before it can be sent.',
  next_actions: {
    has_new_information: {
      action: 'send_message',
      instruction: 'Remove only the agreement or acknowledgement wording, then resend while preserving every substantive claim, reason, correction, suggestion, or question from the draft.',
    },
    agreement_only: {
      action: 'react_message',
      suggested_message_id: replyTo,
      fallback: 'stay_silent',
    },
  },
});

const fixture = (name: string, userText: string, rejectedDraft: string): EvalFixture => {
  const messageId = name === 'substantive-draft' ? '101' : '102';
  const turnResponses: TurnResponseV2[] = [{
    requestedAtMs: 2_000,
    entries: [
      {
        kind: 'message',
        role: 'assistant',
        parts: [{
          kind: 'toolCall',
          callId: `review-${messageId}`,
          name: 'send_message',
          args: JSON.stringify({ text: rejectedDraft, reply_to: messageId }),
        }],
        reasoning: undefined,
      },
      {
        kind: 'toolResult',
        callId: `review-${messageId}`,
        payload: reviewResult(messageId),
        requiresFollowUp: true,
      },
    ],
    inputTokens: 0,
    outputTokens: 0,
    modelName: 'fixture',
  }];

  return {
    name,
    ic: {
      sessionId: `agreement-review-${messageId}`,
      nodes: [{
        type: 'message',
        messageId,
        sender: { id: 'user-1', displayName: 'Alice', isBot: false },
        receivedAtMs: 1_000,
        timestampSec: 1,
        utcOffsetMin: 480,
        content: [{ type: 'text', text: userText }],
        attachments: [],
      }],
      users: new Map(),
    },
    turnResponses,
  };
};

export default [
  fixture(
    'substantive-draft',
    '这里看起来是少传了 abort signal',
    '确实，这里少传了 abort signal',
  ),
  fixture(
    'agreement-only-draft',
    '这个修复就是应该优先保留有效信息',
    '确实',
  ),
] satisfies EvalFixture[];
