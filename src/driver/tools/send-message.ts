// @ts-ignore
import markdownParser from 'prettier/esm/parser-markdown.mjs';
// @ts-ignore
import prettier from 'prettier/esm/standalone.mjs';

import type { CahciuaTool, SendMessageAttachment, SendMessageTurnFlags } from './types';
import { createTool } from './types';

const RIGID_CONTRAST_RE = /(?:不是[\s\S]{1,20}?(?:而是|(?<![不而])是)|(?<!不)是[\s\S]{1,20}?不是)/u;

export const createSendMessageTool = (
  send: (text: string, replyTo?: string, attachments?: SendMessageAttachment[]) => Promise<{ messageId: string }>,
  turnFlags?: SendMessageTurnFlags,
  canReact = false,
  rejectRigidContrast = true,
): CahciuaTool => {
  let queshiFlaggedThisTurn = false;
  let rigidContrastFlaggedThisTurn = false;

  const properties: Record<string, unknown> = {
    text: { type: 'string', description: 'The message to send. When sending attachments, this becomes the caption.' },
    reply_to: { type: 'string', description: 'A message id to reply to.' },
    still_working: {
      type: 'boolean',
      description: 'Set to true if you are still working and need to perform additional actions after this message (e.g., send another message, use another tool). Defaults to false.',
    },
    attachments: {
      type: 'array',
      description: 'Media attachments to send. Multiple attachments are sent as a media group (album). Telegram media groups support up to 10 items; photos and videos can be mixed, but audio and documents must be grouped separately.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'video_note'],
            description: 'The type of media to send.',
          },
          path: { type: 'string', description: 'File path in the workspace.' },
          file_name: { type: 'string', description: 'Override filename (for document type only).' },
        },
        required: ['type', 'path'],
      },
    },
  };

  return createTool({
    name: 'send_message',
    execution: {
      lane: 'message',
      waitForWriters: input => {
        const { attachments } = input as { attachments?: SendMessageAttachment[] };
        return (attachments?.length ?? 0) > 0;
      },
    },
    description: 'Send a message in the current conversation, optionally with media attachments.',
    parameters: {
      type: 'object',
      properties,
      required: ['text'],
    },
    execute: async input => {
      const { text, reply_to, still_working, attachments } = input as {
        text: string;
        reply_to?: string;
        still_working?: boolean;
        attachments?: SendMessageAttachment[];
      };
      // Enforce 256-byte hard limit when the message does not contain code blocks or blockquotes
      const inFocusMode = turnFlags?.inFocusMode ?? false;
      const hasBlockquote = /^> /m.test(text);
      if (!inFocusMode && !text.includes('```') && !hasBlockquote) {
        const byteLength = Buffer.byteLength(text, 'utf8');
        if (byteLength > 256) {
          if (turnFlags) turnFlags.wasLengthLimited = true;
          return {
            content: JSON.stringify({ ok: false, error: 'Message is too long, try reduce sentence length or split into multiple messages. If you need to quote a large block of text verbatim, use a blockquote (> ) or code block (```).' }),
            requiresFollowUp: true,
          };
        }
      }
      if (!queshiFlaggedThisTurn && text.includes('确实')) {
        queshiFlaggedThisTurn = true;
        const agreementOnly = canReact
          ? {
              action: 'react_message',
              ...(reply_to ? { suggested_message_id: reply_to } : {}),
              instruction: reply_to
                ? 'React to the replied-to message. Choose an allowed emoji that matches the intended acknowledgement.'
                : 'Choose the relevant message id from the chat context and an allowed emoji that matches the intended acknowledgement.',
              fallback: 'stay_silent',
            }
          : {
              action: 'stay_silent',
              instruction: 'Do not replace the draft with another text-only acknowledgement.',
            };
        return {
          content: JSON.stringify({
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
          }),
          requiresFollowUp: true,
        };
      }
      if (rejectRigidContrast && !rigidContrastFlaggedThisTurn && RIGID_CONTRAST_RE.test(text)) {
        rigidContrastFlaggedThisTurn = true;
        return {
          content: JSON.stringify({
            ok: false,
            code: 'contrast_review_required',
            error: 'The draft uses a rigid contrast pattern that may contain a meaningless transition and must be regenerated before it can be sent.',
            next_action: {
              action: 'send_message',
              instruction: 'Regenerate the draft without using “不是…而是…”, “是…不是…”, or “不是…是…” as a fixed template. Decide whether the contrast is meaningful: preserve it in a more natural form when useful, or remove the transition when it adds no meaning.',
            },
          }),
          requiresFollowUp: true,
        };
      }
      const formattedText = prettier.format(text, { parser: 'markdown', plugins: [markdownParser], embeddedLanguageFormatting: 'auto' });
      const result = await send(formattedText, reply_to, attachments);
      return {
        content: JSON.stringify({ ok: true, message_id: result.messageId }),
        requiresFollowUp: still_working ?? (turnFlags?.wasLengthLimited ?? false),
      };
    },
  });
};
