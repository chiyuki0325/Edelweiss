import { humanMessage, imageBlock, textBlock, type DriverInputBlock, type DriverMessage } from './messages';
import type { RenderedContext, RenderedContentPiece } from '../rendering/types';

const pieceToBlock = (piece: RenderedContentPiece): DriverInputBlock =>
  piece.type === 'text'
    ? textBlock(piece.text)
    : imageBlock(piece.image, 'low');

// RC segments and persisted LangChain messages share one timestamp-ordered
// timeline. Adjacent RC segments collapse into one HumanMessage.
export const mergeContext = (
  rc: RenderedContext,
  trs: { requestedAtMs: number; entries: DriverMessage[] }[],
): DriverMessage[] => {
  type Slot =
    | { kind: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
    | { kind: 'tr'; time: number; step: number; entry: DriverMessage };

  const slots: Slot[] = [];
  for (const segment of rc)
    slots.push({ kind: 'rc', time: segment.receivedAtMs, step: -1, content: segment.content });
  for (const tr of trs)
    for (const [step, entry] of tr.entries.entries())
      slots.push({ kind: 'tr', time: tr.requestedAtMs, step, entry });

  slots.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.kind !== b.kind) return a.kind === 'rc' ? -1 : 1;
    return a.step - b.step;
  });

  const out: DriverMessage[] = [];
  let pending: RenderedContentPiece[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    out.push(humanMessage(pending.map(pieceToBlock)));
    pending = [];
  };
  for (const slot of slots) {
    if (slot.kind === 'rc') {
      pending.push(...slot.content);
    } else {
      flushPending();
      out.push(slot.entry);
    }
  }
  flushPending();
  return out;
};
