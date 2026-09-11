/**
 * Timeline zoom arithmetic.
 *
 * Pure, so the behaviour is pinned down by tests rather than by feel:
 *
 * - "fit" picks the zoom that shows a whole span in the viewport, with a small
 *   margin so the last clip's end is not flush against the edge;
 * - zooming keeps an ANCHOR still on screen - the playhead for the buttons and
 *   keys, the pointer for Ctrl+wheel. Scaling around the left edge instead,
 *   which is what the buttons used to do, throws whatever you were looking at
 *   off screen with every click.
 */

// Low enough to show three hours of 60 fps footage in a 1400 px timeline
// (0.0022 px/frame). At the old floor of 0.05, a 45-minute clip showed only
// its first 16 minutes with the timeline zoomed all the way out.
export const MIN_PIXELS_PER_FRAME = 0.002;
export const MAX_PIXELS_PER_FRAME = 60;

/** Share of the viewport left empty after the content when fitting. */
const FIT_MARGIN = 0.04;

const clampZoom = (value: number): number =>
  Math.min(MAX_PIXELS_PER_FRAME, Math.max(MIN_PIXELS_PER_FRAME, value));

/**
 * Pixels per frame that make `frames` fill the viewport.
 *
 * A viewport that has not been measured yet, or an empty span, returns null
 * rather than a nonsense zoom - the caller keeps what it has.
 */
export function fitZoom(frames: number, viewportPx: number): number | null {
  if (!(frames > 0) || !(viewportPx > 0)) return null;
  return clampZoom((viewportPx * (1 - FIT_MARGIN)) / frames);
}

export interface ZoomView {
  pixelsPerFrame: number;
  scrollLeftPx: number;
}

/**
 * Zoom by `factor`, keeping the timeline point under `anchorPx` (a position
 * inside the viewport) exactly where it is.
 *
 * The frame under the anchor is `(scroll + anchor) / ppf`; after zooming it
 * must still sit at `anchor`, so the new scroll is `frame * ppf' - anchor`.
 */
export function zoomAround(view: ZoomView, factor: number, anchorPx: number): ZoomView {
  const pixelsPerFrame = clampZoom(view.pixelsPerFrame * factor);
  const anchorFrame = (view.scrollLeftPx + anchorPx) / view.pixelsPerFrame;
  const scrollLeftPx = Math.max(0, anchorFrame * pixelsPerFrame - anchorPx);
  return { pixelsPerFrame, scrollLeftPx };
}

/**
 * Where to anchor a zoom from the buttons or keys: the playhead when it is on
 * screen, which is where an editor is looking; the middle of the view when it
 * is not.
 */
export function playheadAnchor(view: ZoomView, playheadFrame: number, viewportPx: number): number {
  const x = playheadFrame * view.pixelsPerFrame - view.scrollLeftPx;
  return x >= 0 && x <= viewportPx ? x : viewportPx / 2;
}

/** True when the whole of `[start, end)` is inside the viewport. */
export function isSpanVisible(
  view: ZoomView,
  start: number,
  end: number,
  viewportPx: number,
): boolean {
  if (!(viewportPx > 0)) return true; // Nothing measured yet: nothing to fix.
  const left = start * view.pixelsPerFrame - view.scrollLeftPx;
  const right = end * view.pixelsPerFrame - view.scrollLeftPx;
  return left >= 0 && right <= viewportPx;
}

/**
 * The view that shows a span that is currently off screen.
 *
 * Zooming out to fit everything is the answer only when it has to be: if the
 * span fits at the current zoom, the view just scrolls to it, so an editor who
 * zoomed in on purpose keeps their zoom. The span is placed with the same
 * margin `fitZoom` leaves.
 */
export function revealSpan(
  view: ZoomView,
  start: number,
  end: number,
  contentFrames: number,
  viewportPx: number,
): ZoomView {
  if (isSpanVisible(view, start, end, viewportPx)) return view;

  const spanPx = (end - start) * view.pixelsPerFrame;
  if (spanPx <= viewportPx * (1 - FIT_MARGIN)) {
    // Scroll so the span ends just inside the right edge, or starts at the
    // left edge if it lies to the left of the view.
    const leftOfView = start * view.pixelsPerFrame < view.scrollLeftPx;
    const scrollLeftPx = leftOfView
      ? start * view.pixelsPerFrame - viewportPx * FIT_MARGIN
      : end * view.pixelsPerFrame - viewportPx * (1 - FIT_MARGIN);
    return { pixelsPerFrame: view.pixelsPerFrame, scrollLeftPx: Math.max(0, scrollLeftPx) };
  }

  const pixelsPerFrame = fitZoom(Math.max(contentFrames, end), viewportPx) ?? view.pixelsPerFrame;
  return { pixelsPerFrame, scrollLeftPx: 0 };
}
