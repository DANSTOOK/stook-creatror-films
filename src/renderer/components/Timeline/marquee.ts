import type { ProjectState, Track } from '@shared/types';
import { clipEndFrame } from './timelineOps';

/**
 * Rubber-band selection and group moves - pure, so they are unit tested.
 *
 * A marquee selects every clip it TOUCHES, the way dragging across text picks
 * up every word it crosses, not only the ones it fully contains: requiring
 * full containment makes long clips nearly impossible to catch.
 */

export interface MarqueeSpan {
  /** Timeline frames at the two horizontal ends, in either order. */
  frameA: number;
  frameB: number;
  /** Track row indices (draw order) at the two vertical ends, in either order. */
  rowA: number;
  rowB: number;
}

export function clipsInMarquee(
  project: ProjectState,
  orderedTracks: readonly Track[],
  span: MarqueeSpan,
): string[] {
  const firstFrame = Math.min(span.frameA, span.frameB);
  const lastFrame = Math.max(span.frameA, span.frameB);
  const firstRow = Math.max(0, Math.min(span.rowA, span.rowB));
  const lastRow = Math.min(orderedTracks.length - 1, Math.max(span.rowA, span.rowB));

  // Locked tracks are left out: nothing on them can be moved or deleted, and a
  // selection that quietly includes them would only mislead.
  const rows = new Set(
    orderedTracks
      .slice(firstRow, lastRow + 1)
      .filter((track) => !track.locked)
      .map((track) => track.id),
  );

  return Object.values(project.clips)
    .filter(
      (clip) =>
        rows.has(clip.trackId) && clip.startFrame <= lastFrame && clipEndFrame(clip) >= firstFrame,
    )
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((clip) => clip.id);
}

/**
 * New start frames for a group moved by `delta`.
 *
 * The delta is clamped so the earliest clip stops at frame 0 - otherwise
 * dragging a group left would squash its first clip against the start while
 * the rest kept moving, silently changing the spacing inside the group.
 */
export function groupMoveStarts(
  origins: ReadonlyMap<string, number>,
  delta: number,
): Map<string, number> {
  const earliest = Math.min(...origins.values());
  const clamped = Math.max(Math.round(delta), -earliest);

  const starts = new Map<string, number>();
  for (const [id, start] of origins) starts.set(id, start + clamped);
  return starts;
}
