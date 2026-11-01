const RIGID_CONTRAST_RE = /(?:不是[\s\S]{1,20}?(?:而是|(?<![不而])是)|(?<!不)是[\s\S]{1,20}?不是)/u;

/**
 * First offending draft of each kind per turn gets a review prompt.
 * Returns the rejection payload JSON, or null when the draft may be sent.
 */
export const createSendMessageSpeechTicReview = (
  canReact: boolean,
  rejectRigidContrast: boolean,
  rejectQueshi: boolean,
) => {
  let agreementFlaggedThisTurn = false;
  let rigidContrastFlaggedThisTurn = false;

  return (text: string, replyTo: string | undefined, inFocusMode: boolean): string | null => {
    if (inFocusMode)
      return null;

    // DeepSeek v4 系列模型喜欢发送「确实」，通常没有任何实质内容
    if (rejectQueshi && !agreementFlaggedThisTurn && text.includes('确实')) {
      agreementFlaggedThisTurn = true;
      const agreementOnly = canReact
        ? {
            action: 'react_message',
            ...(replyTo ? { suggested_message_id: replyTo } : {}),
            instruction: replyTo
              ? 'React to the replied-to message. Choose an allowed emoji that matches the intended acknowledgement.'
              : 'Choose the relevant message id from the chat context and an allowed emoji that matches the intended acknowledgement.',
            fallback: 'stay_silent',
          }
        : {
            action: 'stay_silent',
            instruction: 'Do not replace the draft with another text-only acknowledgement.',
          };
      return JSON.stringify({
        ok: false,
        code: 'agreement_review_required',
        error: 'The draft contains “确实” and needs a semantic review before it can be sent.',
        next_actions: {
          has_new_information: {
            action: 'send_message',
            instruction: 'Remove only the agreement or acknowledgement wording, then resend while preserving every substantive claim, reason, correction, suggestion, or question from the draft.',
          },
          agreement_only: agreementOnly,
        },
      });
    }

    // 「不是 而是」是 LLM 都喜欢的固定模板
    if (rejectRigidContrast && !rigidContrastFlaggedThisTurn && RIGID_CONTRAST_RE.test(text)) {
      rigidContrastFlaggedThisTurn = true;
      return JSON.stringify({
        ok: false,
        code: 'contrast_review_required',
        error: 'The draft uses a rigid contrast pattern that may contain a meaningless transition and must be regenerated before it can be sent.',
        next_action: {
          action: 'send_message',
          instruction: 'Regenerate the draft without using “不是…而是…”, “是…不是…”, or “不是…是…” as a fixed template. Decide whether the contrast is meaningful: preserve it in a more natural form when useful, or remove the transition when it adds no meaning.',
        },
      });
    }

    return null;
  };
};
