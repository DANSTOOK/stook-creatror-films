import type { EditorUiState } from '@renderer/store/types';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';

/**
 * The timeline's zoom buttons, slider steps and Fit, eased rather than cut.
 *
 * The store works out where a zoom ends (zoomBy, zoomToFit); this runs that,
 * reads the view it lands on, and travels there from the view it left, over
 * a fifth of a second - the scale on a log curve, as a zoom is felt, and the
 * scroll worked out each frame so the one frame that stays put under both
 * views (the playhead, for a step) stays put all the way, instead of the
 * picture sliding sideways and back.
 *
 * Only commands are eased. The wheel and a dragged slider follow the hand at
 * once, as every drag in the app does; and with reduced motion, during
 * playback or an export, a zoom is simply there.
 */

const DURATION_MS = 200;
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

let running = 0;

/**
 * Whether an eased zoom is under way. The timeline's scroll listener stands
 * aside meanwhile: each step sets the scroll in the store before React has
 * moved the scrollbar to it, and the scroll event of the step before, read
 * in that gap, would put the old offset back under the new scale - the
 * picture jumping a few pixels sideways mid-zoom.
 */
export const zooming = (): boolean => running !== 0 || performance.now() < settledAt;

/** Until when, after landing, a late scroll event of the last steps is still not the user's. */
let settledAt = 0;
const SETTLE_MS = 120;

interface View {
  pixelsPerFrame: number;
  scrollLeftPx: number;
}

/** The store the view lives in: the editor's own, or a detached timeline's. */
export interface ZoomStore {
  getState(): { ui: Pick<EditorUiState, 'pixelsPerFrame' | 'scrollLeftPx'>; setUi(patch: Partial<EditorUiState>): void };
}

/** Run `zoom` (a store action that changes the view), and ease from the old view to its result. */
export function smoothZoom(store: ZoomStore, zoom: () => void): void {
  if (running) {
    cancelFrame(running);
    running = 0;
  }
  const viewOf = (): View => {
    const { ui } = store.getState();
    return { pixelsPerFrame: ui.pixelsPerFrame, scrollLeftPx: ui.scrollLeftPx };
  };
  const from = viewOf();
  zoom();
  const to = viewOf();
  if (motionReduced() || motionQuiet() || (from.pixelsPerFrame === to.pixelsPerFrame && from.scrollLeftPx === to.scrollLeftPx)) return;

  // The frame at the same place on screen in both views: what the zoom turns about.
  const sameScale = Math.abs(from.pixelsPerFrame - to.pixelsPerFrame) < 1e-9;
  const pivotFrame = sameScale ? 0 : (from.scrollLeftPx - to.scrollLeftPx) / (from.pixelsPerFrame - to.pixelsPerFrame);
  const pivotPx = pivotFrame * from.pixelsPerFrame - from.scrollLeftPx;
  const logFrom = Math.log(from.pixelsPerFrame);
  const logTo = Math.log(to.pixelsPerFrame);

  const { setUi } = store.getState();
  setUi(from);
  const started = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - started) / DURATION_MS);
    if (t >= 1) {
      running = 0;
      settledAt = performance.now() + SETTLE_MS;
      setUi(to);
      return;
    }
    const k = easeOut(t);
    const pixelsPerFrame = Math.exp(logFrom + (logTo - logFrom) * k);
    const scrollLeftPx = sameScale
      ? Math.round(from.scrollLeftPx + (to.scrollLeftPx - from.scrollLeftPx) * k)
      : Math.max(0, Math.round(pivotFrame * pixelsPerFrame - pivotPx));
    setUi({ pixelsPerFrame, scrollLeftPx });
    running = requestFrame(step);
  };
  running = requestFrame(step);
}
