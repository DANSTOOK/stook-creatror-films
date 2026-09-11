import type { Clip } from '@shared/types';
import { clipEndFrame } from './timelineOps';

/**
 * Point 8: clips on one track never overlap.
 *
 * Two clips on the same track at the same time both reach the export, one
 * stacked over the other - an image dropped just before a video covered the
 * start of the video in the render. On a track, clips follow one another,
 * strictly: something put where others already are is INSERTED there, and
 * whatever it would cover moves along to make room.
 *
 * Pure, so the rules are tested directly.
 */

export interface Insertion {
  /** Where the inserted clip starts. */
  startFrame: number;
  /** New start frames for the clips that had to move along, by id. */
  shifts: Map<string, number>;
}

/**
 * Insert `length` frames at `desiredStart` among `others` (the clips already on
 * the track, not including the one being inserted).
 *
 * - Landing inside a clip snaps to its nearer edge: its first half inserts
 *   before it, its second half after it. A clip is never cut in two by this.
 * - Everything from the insertion point on that would be covered is pushed
 *   right, each clip only as far as needed; a clip that already clears the
 *   one before it stays put, and so does everything after it.
 */
export function insertIntoTrack(others: readonly Clip[], desiredStart: number, length: number): Insertion {
  const sorted = [...others].sort((a, b) => a.startFrame - b.startFrame);
  let start = Math.max(0, Math.round(desiredStart));

  const inside = sorted.find((clip) => clip.startFrame < start && start < clipEndFrame(clip));
  if (inside) {
    const intoClip = start - inside.startFrame;
    start = intoClip < inside.durationFrames / 2 ? inside.startFrame : clipEndFrame(inside);
  }

  const shifts = new Map<string, number>();
  let cursor = start + Math.max(1, Math.round(length));
  for (const clip of sorted) {
    if (clip.startFrame < start) continue;
    if (clip.startFrame >= cursor) break;
    shifts.set(clip.id, cursor);
    cursor += clip.durationFrames;
  }

  return { startFrame: start, shifts };
}

/** Clips on `trackId`, leaving out `exclude`. */
export const clipsOnTrackExcept = (
  clips: Record<string, Clip>,
  trackId: string,
  exclude: ReadonlySet<string>,
): Clip[] => Object.values(clips).filter((clip) => clip.trackId === trackId && !exclude.has(clip.id));

/**
 * Whether putting the given clips at these starts would overlap a clip that is
 * not moving. Group moves stop against other clips rather than pushing them:
 * pushing a clip into the middle of a moving group has no sensible answer.
 */
export function groupMoveCollides(clips: Record<string, Clip>, starts: ReadonlyMap<string, number>): boolean {
  for (const [id, start] of starts) {
    const moving = clips[id];
    if (!moving) continue;
    const end = start + moving.durationFrames;
    for (const other of Object.values(clips)) {
      if (starts.has(other.id) || other.trackId !== moving.trackId) continue;
      if (other.startFrame < end && start < clipEndFrame(other)) return true;
    }
  }
  return false;
}

/**
 * The magnet (point 9): close the hole `[gapStart, gapStart + length)` left on
 * a track, by moving every clip at or after it left by `length`.
 *
 * Only the hole this edit made closes. A gap the editor left on purpose
 * elsewhere - before the removed clip, or further along - is still there
 * afterwards, because everything after the hole moves by the same amount.
 * `exclude` keeps the clip being edited itself out of it.
 */
export function closeGap(
  clips: Record<string, Clip>,
  trackId: string,
  gapStart: number,
  length: number,
  exclude: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const shifts = new Map<string, number>();
  if (length <= 0) return shifts;
  for (const clip of Object.values(clips)) {
    if (clip.trackId !== trackId || exclude.has(clip.id) || clip.startFrame < gapStart) continue;
    shifts.set(clip.id, Math.max(0, clip.startFrame - length));
  }
  return shifts;
}

/**
 * Delete with the magnet: remove the clips and close each hole on its track.
 * Holes are closed from the last one back, so an earlier hole's shift never
 * changes where a later one is.
 */
export function rippleDelete(clips: Record<string, Clip>, ids: ReadonlySet<string>): Map<string, number> {
  const doomed = Object.values(clips)
    .filter((clip) => ids.has(clip.id))
    .sort((a, b) => b.startFrame - a.startFrame);

  const starts = new Map<string, number>();
  const current = (clip: Clip): Clip => ({ ...clip, startFrame: starts.get(clip.id) ?? clip.startFrame });
  const survivors = Object.fromEntries(Object.entries(clips).filter(([id]) => !ids.has(id)));

  for (const gone of doomed) {
    const live = Object.fromEntries(Object.entries(survivors).map(([id, clip]) => [id, current(clip)]));
    for (const [id, start] of closeGap(live, gone.trackId, clipEndFrame(gone), gone.durationFrames)) {
      starts.set(id, start);
    }
  }
  return starts;
}

/**
 * How far a trimmed edge may go before it runs into a neighbour on its track:
 * the end of the clip before (for the start edge) or the start of the clip
 * after (for the end edge).
 */
export function trimLimit(clips: Record<string, Clip>, clip: Clip, edge: 'start' | 'end'): number {
  const neighbours = Object.values(clips).filter((other) => other.trackId === clip.trackId && other.id !== clip.id);
  if (edge === 'start') {
    return neighbours
      .filter((other) => clipEndFrame(other) <= clip.startFrame)
      .reduce((limit, other) => Math.max(limit, clipEndFrame(other)), 0);
  }
  return neighbours
    .filter((other) => other.startFrame >= clipEndFrame(clip))
    .reduce((limit, other) => Math.min(limit, other.startFrame), Infinity);
}
