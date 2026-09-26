import type { ZoomView } from './zoom';

/**
 * A timeline zoom you can follow.
 *
 * The store changes the zoom at once - every click, hit test and test reads
 * the final value straight away - and the canvas eases what it DRAWS towards
 * it. Each wheel notch, each pinch event, each click of + or - just moves the
 * target: the view carries on from wherever it is, so a gesture is tracked
 * rather than queued, and it never lags more than a few frames behind.
 *
 * - The approach is exponential in the zoom's logarithm (a doubling takes as
 *   long as a halving), with a time constant of 32 ms: 95% of the way in about
 *   100 ms, settled in about 150 ms.
 * - The point that stays still is the one that stays still between where the
 *   view is and where it is going - the pointer for Ctrl+wheel, the playhead
 *   for the keys - so the zoom grows out of it on every frame, not only at
 *   the end.
 * - A scroll alone (the scrollbar, the wheel, page-follow during playback) is
 *   never animated: it is drawn where it is, 1:1.
 */

export interface DisplayedView extends ZoomView {}

/** Frames drawn part-way through a zoom, for the motion test to count. */
export const zoomStats = { frames: 0 };

/** Time constant of the approach, in milliseconds. */
export const ZOOM_TAU_MS = 32;
/** Closer than this (a ratio, in log terms) is arrived. */
const ARRIVED = 0.0015;

const sameZoom = (a: number, b: number): boolean => Math.abs(Math.log(a / b)) < ARRIVED;

/**
 * One frame of the approach from `shown` towards `target`, `dt` milliseconds
 * later. `viewportPx` bounds the fixed point to somewhere near the screen.
 */
export function stepZoomView(
  shown: DisplayedView | null,
  target: ZoomView,
  dt: number,
  viewportPx: number,
  instant = false,
): { view: DisplayedView; moving: boolean } {
  if (!shown || instant || !(target.pixelsPerFrame > 0)) return { view: { ...target }, moving: false };
  // Nothing about the zoom changed: a scroll, drawn as it is.
  if (sameZoom(shown.pixelsPerFrame, target.pixelsPerFrame)) return { view: { ...target }, moving: false };

  const k = 1 - Math.exp(-Math.max(0, dt) / ZOOM_TAU_MS);
  const logShown = Math.log(shown.pixelsPerFrame);
  const pixelsPerFrame = Math.exp(logShown + (Math.log(target.pixelsPerFrame) - logShown) * k);
  if (sameZoom(pixelsPerFrame, target.pixelsPerFrame)) return { view: { ...target }, moving: false };

  // The frame at the left edge, now and at the target.
  const leftShown = shown.scrollLeftPx / shown.pixelsPerFrame;
  const leftTarget = target.scrollLeftPx / target.pixelsPerFrame;
  // The screen x that shows the same frame in both views: zoom around it.
  const inverse = 1 / shown.pixelsPerFrame - 1 / target.pixelsPerFrame;
  const fixedX = (leftTarget - leftShown) / inverse;
  let left: number;
  if (Number.isFinite(fixedX) && fixedX > -viewportPx && fixedX < viewportPx * 2) {
    const fixedFrame = leftShown + fixedX / shown.pixelsPerFrame;
    left = fixedFrame - fixedX / pixelsPerFrame;
  } else {
    // No sensible still point (zoom to fit from far away): travel straight.
    left = leftShown + (leftTarget - leftShown) * k;
  }
  zoomStats.frames += 1;
  return { view: { pixelsPerFrame, scrollLeftPx: Math.max(0, left * pixelsPerFrame) }, moving: true };
}

/**
 * The zoom factor for one wheel event.
 *
 * A mouse wheel notch is 100 px of deltaY (or 3 lines) and zooms by 1.25, as
 * it always has. A touchpad pinch arrives as a stream of Ctrl+wheel events
 * with small, fractional deltas; each one used to zoom by the same 1.25, so a
 * gentle pinch shot across the whole range. Now the zoom is proportional to
 * the delta, so a pinch zooms exactly as far as the fingers move.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  const factor = Math.exp((-pixels * Math.log(1.25)) / 100);
  return Math.min(2, Math.max(0.5, factor));
}
