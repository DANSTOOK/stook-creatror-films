import type { ProjectState } from '@shared/types';
import { clipEndFrame } from './timelineOps';

/**
 * Magnetic snapping.
 *
 * The threshold is expressed in SCREEN pixels, not frames, so the magnet feels
 * identical at every zoom level: at 40 px/frame a 10 px threshold is a quarter
 * of a frame, at 0.2 px/frame it is 50 frames.
 */

export const DEFAULT_SNAP_THRESHOLD_PX = 10;

export interface SnapTarget {
  frame: number;
  kind: 'playhead' | 'clip-start' | 'clip-end' | 'timeline-start' | 'marker';
  /** Clip that produced the target, for the on-screen snap indicator. */
  clipId?: string;
}

export interface SnapResult {
  frame: number;
  snapped: boolean;
  target?: SnapTarget;
  distancePx: number;
}

export interface SnapOptions {
  pixelsPerFrame: number;
  thresholdPx?: number;
  enabled?: boolean;
}

/**
 * Every frame a dragged edge can latch onto: clip boundaries, the playhead, the
 * start of the timeline and any markers.
 *
 * Clips being dragged are excluded so an edge never snaps to itself.
 */
export function collectSnapTargets(
  project: ProjectState,
  options: { excludeClipIds?: Iterable<string>; markers?: number[] } = {},
): SnapTarget[] {
  const excluded = new Set(options.excludeClipIds ?? []);
  const targets: SnapTarget[] = [
    { frame: 0, kind: 'timeline-start' },
    { frame: project.currentFrame, kind: 'playhead' },
  ];

  for (const clip of Object.values(project.clips)) {
    if (excluded.has(clip.id)) continue;
    targets.push({ frame: clip.startFrame, kind: 'clip-start', clipId: clip.id });
    targets.push({ frame: clipEndFrame(clip), kind: 'clip-end', clipId: clip.id });
  }

  for (const marker of options.markers ?? []) {
    targets.push({ frame: marker, kind: 'marker' });
  }

  return targets;
}

/**
 * Snap `frame` to the nearest target within the pixel threshold.
 *
 * Ties resolve to the earlier target, which keeps repeated drags deterministic.
 */
export function snapFrame(
  frame: number,
  targets: readonly SnapTarget[],
  options: SnapOptions,
): SnapResult {
  const { pixelsPerFrame, thresholdPx = DEFAULT_SNAP_THRESHOLD_PX, enabled = true } = options;

  if (!enabled || targets.length === 0 || pixelsPerFrame <= 0) {
    return { frame, snapped: false, distancePx: Number.POSITIVE_INFINITY };
  }

  let best: SnapTarget | undefined;
  let bestDistancePx = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const distancePx = Math.abs(target.frame - frame) * pixelsPerFrame;
    if (distancePx > thresholdPx) continue;
    if (distancePx < bestDistancePx || (distancePx === bestDistancePx && target.frame < (best?.frame ?? Infinity))) {
      best = target;
      bestDistancePx = distancePx;
    }
  }

  if (!best) return { frame, snapped: false, distancePx: Number.POSITIVE_INFINITY };
  return { frame: best.frame, snapped: true, target: best, distancePx: bestDistancePx };
}

/**
 * Snap a clip move by testing BOTH edges and applying whichever latches first.
 *
 * Testing only the leading edge is the usual bug here: dragging a clip so its
 * tail meets the next clip should snap just as readily as its head.
 */
export function snapClipMove(
  startFrame: number,
  durationFrames: number,
  targets: readonly SnapTarget[],
  options: SnapOptions,
): SnapResult {
  const head = snapFrame(startFrame, targets, options);
  const tailSnap = snapFrame(startFrame + durationFrames, targets, options);
  const tail: SnapResult = {
    ...tailSnap,
    frame: tailSnap.frame - durationFrames,
  };

  if (head.snapped && tail.snapped) {
    return head.distancePx <= tail.distancePx ? head : tail;
  }
  if (head.snapped) return head;
  if (tail.snapped) return tail;

  return { frame: startFrame, snapped: false, distancePx: Number.POSITIVE_INFINITY };
}

/** Convert an x offset inside the timeline surface to a frame number. */
export const pixelToFrame = (
  x: number,
  pixelsPerFrame: number,
  scrollLeftPx = 0,
): number => Math.max(0, Math.round((x + scrollLeftPx) / pixelsPerFrame));

export const frameToPixel = (
  frame: number,
  pixelsPerFrame: number,
  scrollLeftPx = 0,
): number => frame * pixelsPerFrame - scrollLeftPx;
