/**
 * The in and out points: the stretch of the timeline being worked on.
 *
 * Marked with I and O, as in every editor since tape. They say what an export
 * renders, and what a three-point edit fills - so the rules about which one
 * gives way matter more than they look.
 */

export interface MarkedRange {
  /** First frame of the range; null when unmarked. */
  inFrame: number | null;
  /** One past the last frame, so `out - in` is a length; null when unmarked. */
  outFrame: number | null;
}

export const EMPTY_RANGE: MarkedRange = { inFrame: null, outFrame: null };

const floor = (frame: number): number => Math.max(0, Math.floor(frame));

/**
 * Mark the in point.
 *
 * An in point at or after the out point would be a negative range, so the out
 * point gives way - the mark just made is the one the editor meant.
 */
export function withInPoint(range: MarkedRange, frame: number): MarkedRange {
  const inFrame = floor(frame);
  return { inFrame, outFrame: range.outFrame !== null && range.outFrame <= inFrame ? null : range.outFrame };
}

/** Mark the out point; the in point gives way if it would be left after it. */
export function withOutPoint(range: MarkedRange, frame: number): MarkedRange {
  // The out point is exclusive: marking it on frame N keeps frame N in.
  const outFrame = floor(frame) + 1;
  return { outFrame, inFrame: range.inFrame !== null && range.inFrame >= outFrame ? null : range.inFrame };
}

/** How long the marked range is, or null when it is not fully marked. */
export function rangeLength(range: MarkedRange): number | null {
  if (range.inFrame === null || range.outFrame === null) return null;
  const length = range.outFrame - range.inFrame;
  return length > 0 ? length : null;
}

/**
 * The range an export or a three-point edit should use.
 *
 * Both marked: that stretch. Only one: from it to the end, or from the start
 * to it - which is what "render from here" means. Neither: the whole thing.
 */
export function effectiveRange(range: MarkedRange, contentLength: number): { start: number; end: number } {
  const start = range.inFrame ?? 0;
  const end = range.outFrame ?? contentLength;
  return end > start ? { start, end } : { start: 0, end: contentLength };
}
