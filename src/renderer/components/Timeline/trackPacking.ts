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
