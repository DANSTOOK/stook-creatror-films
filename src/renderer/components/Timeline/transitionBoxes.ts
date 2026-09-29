import type { ProjectState, Track, Transition } from '@shared/types';
import { transitionWindow, transitionsOf } from '@renderer/timing/transitions';
import { frameToPixel } from './snapping';

/**
 * Where transitions are drawn on the timeline, and what a pointer there is
 * on: a rounded box across the cut, as wide as the transition is long,
 * over the middle of the clips' row - below the clip names and fade grips,
 * which keep the top of the row. Never narrower than a grabbable few
 * pixels, however far out the timeline is zoomed.
 */

/** Row geometry, handed in so this module does not depend on the canvas. */
export interface RowGeometry {
  rowTop(index: number): number;
  rowHeight: number;
}

export interface TransitionBox {
  transition: Transition;
  trackIndex: number;
  /** The cut, and the box's edges, in canvas pixels. */
  cutX: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Narrowest a box is drawn, so it can always be clicked. */
const MIN_BOX_PX = 12;
/** How close to a box's side counts as grabbing that edge. */
export const EDGE_GRAB_PX = 5;

export function transitionBoxes(
  project: Pick<ProjectState, 'clips' | 'transitions'>,
  tracks: readonly Track[],
  view: { pixelsPerFrame: number; scrollLeftPx: number },
  rows: RowGeometry,
): TransitionBox[] {
  const boxes: TransitionBox[] = [];
  for (const transition of transitionsOf(project)) {
    const from = project.clips[transition.fromClipId];
    if (!from) continue;
    const trackIndex = tracks.findIndex((track) => track.id === from.trackId);
    if (trackIndex < 0) continue;
    const window = transitionWindow(transition, from);
    const cutX = frameToPixel(window.cut, view.pixelsPerFrame, view.scrollLeftPx);
    let left = frameToPixel(window.start, view.pixelsPerFrame, view.scrollLeftPx);
    let right = frameToPixel(window.end, view.pixelsPerFrame, view.scrollLeftPx);
    if (right - left < MIN_BOX_PX) {
      const middle = (left + right) / 2;
      left = middle - MIN_BOX_PX / 2;
      right = middle + MIN_BOX_PX / 2;
    }
    const rowTop = rows.rowTop(trackIndex);
    boxes.push({
      transition,
      trackIndex,
      cutX,
      left,
      right,
      top: rowTop + rows.rowHeight * 0.36,
      bottom: rowTop + rows.rowHeight * 0.84,
    });
  }
  return boxes;
}

/** The transition under the pointer, and which edge of it if on one. */
export function transitionAt(boxes: readonly TransitionBox[], x: number, y: number): { box: TransitionBox; edge: 'start' | 'end' | null } | null {
  for (const box of boxes) {
    if (y < box.top || y > box.bottom) continue;
    if (x < box.left - EDGE_GRAB_PX || x > box.right + EDGE_GRAB_PX) continue;
    if (Math.abs(x - box.left) <= EDGE_GRAB_PX) return { box, edge: 'start' };
    if (Math.abs(x - box.right) <= EDGE_GRAB_PX) return { box, edge: 'end' };
    return { box, edge: null };
  }
  return null;
}

/**
 * The length a dragged edge asks for: both sides move together on a
 * centred transition, as Final Cut's do; one that starts or ends at the cut
 * grows away from it.
 */
export function durationFromEdge(transition: Pick<Transition, 'alignment'>, cutFrame: number, pointerFrame: number): number {
  const distance = pointerFrame - cutFrame;
  if (transition.alignment === 'center') return Math.round(Math.abs(distance) * 2);
  if (transition.alignment === 'start') return Math.round(distance);
  return Math.round(-distance);
}
