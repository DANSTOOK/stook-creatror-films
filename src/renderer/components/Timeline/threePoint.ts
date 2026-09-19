import type { Clip } from '@shared/types';
import { clipEndFrame, splitClip, trimClipEnd, trimClipStart } from './timelineOps';

/**
 * Three-point editing: dropping a piece of source into a stretch of timeline.
 *
 * Two ways, and editors reach for them constantly:
 *
 *  - INSERT (,) puts it in and everything after it moves along, so nothing is
 *    lost and the edit gets longer. The timeline already does this when media
 *    is dropped, so the store reuses that.
 *  - OVERWRITE (.) lays it on top of what is there, replacing exactly the
 *    stretch it covers and leaving the length alone. That is what this file
 *    is for: emptying the stretch first.
 *
 * Emptying is where the awkward cases live. A clip may be swallowed whole,
 * clipped at its head or its tail, or - the one that catches people out -
 * straddle the whole stretch and have to come out in two pieces, with the
 * second keeping the right piece of its source.
 */

export interface ClearedRange {
  /** Clips on the track after the stretch was emptied, by id. */
  clips: Record<string, Clip>;
  /** Clips that went entirely. */
  removed: string[];
  /** Tail pieces created by splitting a clip that straddled the stretch. */
  added: string[];
}

/**
 * Empty `[from, to)` on one track.
 *
 * Only that track is touched: an overwrite on Video 2 leaves Video 1 alone,
 * which is the whole point of layering.
 */
export function clearRange(
  clips: Record<string, Clip>,
  trackId: string,
  from: number,
  to: number,
): ClearedRange {
  const result: Record<string, Clip> = { ...clips };
  const removed: string[] = [];
  const added: string[] = [];
  if (to <= from) return { clips: result, removed, added };

  for (const clip of Object.values(clips)) {
    if (clip.trackId !== trackId) continue;
    const end = clipEndFrame(clip);
    if (end <= from || clip.startFrame >= to) continue;

    const coveredHead = clip.startFrame >= from;
    const coveredTail = end <= to;

    if (coveredHead && coveredTail) {
      delete result[clip.id];
      removed.push(clip.id);
      continue;
    }

    if (!coveredHead && !coveredTail) {
      // Straddles the stretch: keep the head, and the tail as its own clip.
      const halves = splitClip(clip, from);
      if (!halves) continue;
      const [head, rest] = halves;
      const tail = trimClipStart(rest, to);
      result[clip.id] = head;
      result[tail.id] = tail;
      added.push(tail.id);
      continue;
    }

    result[clip.id] = coveredHead ? trimClipStart(clip, to) : trimClipEnd(clip, from);
  }

  return { clips: result, removed, added };
}

/**
 * How long a piece of source should be when it lands.
 *
 * Three points, not four: the marked range says how long, the source says
 * where from. With nothing marked, the whole of the source goes in.
 */
export function editLength(sourceLength: number, markedLength: number | null): number {
  const wanted = markedLength === null ? sourceLength : Math.min(markedLength, sourceLength);
  return Math.max(1, Math.round(wanted));
}
