const RIGID_CONTRAST_RE = /(?:不是[\s\S]{1,20}?(?:而是|(?<![不而])是)|(?<!不)是[\s\S]{1,20}?不是)/u;

// 「我认」是 Opus 4.6 / DeepSeek 0731 的口癖。只匹配独立成句的让步说法：
// 后面必须跟标点或结尾，前面不能是「不」，避免把「我认为」「我认识」「我认同」「我认可」
// 「我认真」「我认出」「我认定」等正常词误判成口癖。
const CONCESSION_RE = /(?<!不)(?:我认(?:栽|了)?|认栽了?)(?=[\s，。！？!?、；;：:…~～）」』”’"'》]|$)/u;

const buildAcknowledgementOnlyAction = (
  canReact: boolean,
  replyTo: string | undefined,
  silentInstruction: string,
) => canReact
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
      instruction: silentInstruction,
    };

/**
 * First offending draft of each kind per turn gets a review prompt.
 * Returns the rejection payload JSON, or null when the draft may be sent.
 */
export const createSendMessageSpeechTicReview = (
  canReact: boolean,
  rejectRigidContrast: boolean,
  rejectQueshi: boolean,
  rejectConcession: boolean,
) => {
  let agreementFlaggedThisTurn = false;
  let rigidContrastFlaggedThisTurn = false;
  let concessionFlaggedThisTurn = false;

  return (text: string, replyTo: string | undefined, inFocusMode: boolean): string | null => {
    if (inFocusMode)
      return null;

    // DeepSeek V4 系列模型喜欢高频发送「确实」（类似Gemini的「极其」）
    if (rejectQueshi && !agreementFlaggedThisTurn && text.includes('确实')) {
      agreementFlaggedThisTurn = true;
      const agreementOnly = buildAcknowledgementOnlyAction(
        canReact,
        replyTo,
        'Do not replace the draft with another text-only acknowledgement.',
      );
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

    // Opus 4.6 / DeepSeek 0731 喜欢把「我认」当口头禅；这种摊牌式认同听起来很消极，
    // 没有实质让步内容时更适合用 reaction 或保持沉默，而不是再发一条文字。
    if (rejectConcession && !concessionFlaggedThisTurn && CONCESSION_RE.test(text)) {
      concessionFlaggedThisTurn = true;
      return JSON.stringify({
        ok: false,
        code: 'concession_review_required',
        error: '该句中使用了「我认」的消极摊牌式让步，表达出一种「反正我就是个bot，爱咋咋地」的拒绝沟通态度，通常令人厌烦。',
        next_actions: {
          has_new_information: {
            action: 'send_message',
            instruction: '可修改为更积极的态度，或「具体承认的点」/之后输出自己的观点，或直接保持沉默。',
          },
          concession_only: buildAcknowledgementOnlyAction(
            canReact,
            replyTo,
            '修改表达方式或保持沉默。',
          ),
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
