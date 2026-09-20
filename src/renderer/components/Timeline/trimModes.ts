import type { Clip } from '@shared/types';
import { clipEndFrame, moveClip, trimClipEnd, trimClipStart } from './timelineOps';

/**
 * The four trims every editor has muscle memory for.
 *
 * DaVinci Resolve puts them all under one tool and picks between them by where
 * the pointer sits; this file is the arithmetic behind each, with the limits
 * that keep an edit honest:
 *
 *  - RIPPLE  drags one edge and takes the rest of the track with it, so the
 *            cut changes length and nothing is left with a hole beside it.
 *  - ROLL    drags the join between two clips: one gives up what the other
 *            takes, and the timeline keeps its length.
 *  - SLIP    keeps a clip where it is and changes which piece of its footage
 *            shows - the shot stays the same length, the moment changes.
 *  - SLIDE   moves a clip between its neighbours, which give and take to keep
 *            the track gapless.
 *
 * Every one of them is limited by how much footage there is: a clip cannot show
 * frames before its source starts or past where it ends. Where the source's
 * length is known it is honoured; where it is not (an image, a file still being
 * probed) only the floor at zero applies.
 */

/** A clip is never trimmed away to nothing. */
const MIN_FRAMES = 1;

export interface TrackClips {
  clips: Record<string, Clip>;
}

const onTrack = (clips: Record<string, Clip>, trackId: string): Clip[] =>
  Object.values(clips)
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);

/** The clip immediately before and after `clip` on its track, if they touch it. */
export function neighbours(
  clips: Record<string, Clip>,
  clip: Clip,
): { previous: Clip | null; next: Clip | null } {
  const ordered = onTrack(clips, clip.trackId);
  const index = ordered.findIndex((candidate) => candidate.id === clip.id);
  return {
    previous: index > 0 ? ordered[index - 1] : null,
    next: index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null,
  };
}

/**
 * Ripple: drag one edge, and everything after it on the track follows.
 *
 * The clip's own limits come first - it cannot lose all its frames, nor show
 * footage it does not have - and whatever it gives up or takes, the clips after
 * it move by exactly that, so the cut neither opens a gap nor overlaps.
 */
export function rippleTrim(
  clips: Record<string, Clip>,
  clipId: string,
  edge: 'start' | 'end',
  targetFrame: number,
  sourceFrames?: number,
): Record<string, Clip> {
  const clip = clips[clipId];
  if (!clip) return clips;

  const target = Math.round(targetFrame);
  let trimmed: Clip;

  if (edge === 'start') {
    // Cannot start before the footage does, nor swallow the whole clip.
    const earliest = clip.startFrame - clip.sourceOffsetFrames;
    const latest = clipEndFrame(clip) - MIN_FRAMES;
    trimmed = trimClipStart(clip, Math.min(Math.max(target, Math.max(0, earliest)), latest));
  } else {
    const available = sourceFrames === undefined
      ? Number.MAX_SAFE_INTEGER
      : clip.startFrame + (sourceFrames - clip.sourceOffsetFrames);
    const latest = Math.min(available, Number.MAX_SAFE_INTEGER);
    trimmed = trimClipEnd(clip, Math.min(Math.max(target, clip.startFrame + MIN_FRAMES), latest));
  }

  // A head trim keeps the clip where it was on the timeline - it shows later
  // footage instead - so the track closes up by what the head lost. A tail trim
  // moves the rest by whatever the tail gained or lost.
  const followDelta = edge === 'start'
    ? -(trimmed.startFrame - clip.startFrame)
    : clipEndFrame(trimmed) - clipEndFrame(clip);

  const result: Record<string, Clip> = {
    ...clips,
    [clip.id]: edge === 'start' ? moveClip(trimmed, clip.startFrame) : trimmed,
  };
  if (followDelta === 0) return result;

  const after = clipEndFrame(clip);
  for (const other of onTrack(clips, clip.trackId)) {
    if (other.id === clip.id || other.startFrame < after) continue;
    result[other.id] = moveClip(other, other.startFrame + followDelta);
  }

  return result;
}

/**
 * Roll: move the join between two touching clips.
 *
 * One gives up exactly what the other takes, so nothing after it moves and the
 * timeline keeps its length - the reason it is the trim for fixing a cut
 * without disturbing the rest of the edit.
 */
export function rollEdit(
  clips: Record<string, Clip>,
  leftId: string,
  rightId: string,
  targetFrame: number,
  sources?: { left?: number; right?: number },
): Record<string, Clip> {
  const left = clips[leftId];
  const right = clips[rightId];
  if (!left || !right) return clips;

  const leftRoom = sources?.left === undefined
    ? Number.MAX_SAFE_INTEGER
    : left.startFrame + (sources.left - left.sourceOffsetFrames);
  const rightRoom = right.startFrame - right.sourceOffsetFrames;

  const earliest = Math.max(left.startFrame + MIN_FRAMES, Math.max(0, rightRoom));
  const latest = Math.min(clipEndFrame(right) - MIN_FRAMES, leftRoom);
  const target = Math.min(Math.max(Math.round(targetFrame), earliest), latest);
  if (!Number.isFinite(target) || latest < earliest) return clips;

  return {
    ...clips,
    [left.id]: trimClipEnd(left, target),
    [right.id]: trimClipStart(right, target),
  };
}

/**
 * Slip: keep the clip where it is, change the footage inside it.
 *
 * Nothing else on the timeline notices - which is what makes it the trim for
 * "the right length, the wrong moment".
 */
export function slipClip(clip: Clip, deltaFrames: number, sourceFrames?: number): Clip {
  const wanted = clip.sourceOffsetFrames + Math.round(deltaFrames);
  const last = sourceFrames === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, sourceFrames - clip.durationFrames);
  return { ...clip, sourceOffsetFrames: Math.min(Math.max(0, wanted), last) };
}

/**
 * Slide: move the clip along, and its neighbours give and take.
 *
 * The clip keeps its length and its footage; the one before it lengthens or
 * shortens, and so does the one after, so the track stays gapless. It can only
 * go as far as those neighbours can afford.
 */
export function slideClip(
  clips: Record<string, Clip>,
  clipId: string,
  deltaFrames: number,
  sources?: { previous?: number },
): Record<string, Clip> {
  const clip = clips[clipId];
  if (!clip) return clips;

  const { previous, next } = neighbours(clips, clip);
  const touchesBefore = previous !== null && clipEndFrame(previous) === clip.startFrame;
  const touchesAfter = next !== null && next.startFrame === clipEndFrame(clip);

  // How far it can go: the previous clip must keep a frame (and its footage),
  // and so must the next.
  let earliest = 0;
  let latest = Number.MAX_SAFE_INTEGER;
  if (touchesBefore && previous) {
    earliest = previous.startFrame + MIN_FRAMES;
    if (sources?.previous !== undefined) {
      latest = Math.min(latest, previous.startFrame + (sources.previous - previous.sourceOffsetFrames));
    }
  }
  if (touchesAfter && next) {
    latest = Math.min(latest, clipEndFrame(next) - MIN_FRAMES - clip.durationFrames);
    earliest = Math.max(earliest, next.startFrame - next.sourceOffsetFrames - clip.durationFrames);
  }

  const start = Math.min(Math.max(clip.startFrame + Math.round(deltaFrames), Math.max(0, earliest)), latest);
  if (start === clip.startFrame || !Number.isFinite(start)) return clips;

  const moved = moveClip(clip, start);
  const result: Record<string, Clip> = { ...clips, [clip.id]: moved };
  if (touchesBefore && previous) result[previous.id] = trimClipEnd(previous, start);
  if (touchesAfter && next) result[next.id] = trimClipStart(next, clipEndFrame(moved));
  return result;
}

/** Where the pointer is on a clip, and so which trim it means. */
export type TrimMode = 'ripple' | 'roll' | 'slip' | 'slide';

export interface TrimTarget {
  mode: TrimMode;
  clipId: string;
  /** Which edge a ripple or roll takes hold of. */
  edge?: 'start' | 'end';
  /** The other half of a roll. */
  otherId?: string;
}

/**
 * Which trim the pointer is asking for, the way Resolve's trim tool decides:
 * near a join that two clips share, it is a roll; near a free edge, a ripple;
 * over the body, slip above and slide below.
 */
export function trimTargetAt(
  clips: Record<string, Clip>,
  clip: Clip,
  frame: number,
  verticalFraction: number,
  edgeFrames: number,
): TrimTarget {
  const { previous, next } = neighbours(clips, clip);
  const nearStart = Math.abs(frame - clip.startFrame) <= edgeFrames;
  const nearEnd = Math.abs(frame - clipEndFrame(clip)) <= edgeFrames;

  if (nearStart && previous && clipEndFrame(previous) === clip.startFrame) {
    return { mode: 'roll', clipId: previous.id, otherId: clip.id, edge: 'end' };
  }
  if (nearEnd && next && next.startFrame === clipEndFrame(clip)) {
    return { mode: 'roll', clipId: clip.id, otherId: next.id, edge: 'end' };
  }
  if (nearStart) return { mode: 'ripple', clipId: clip.id, edge: 'start' };
  if (nearEnd) return { mode: 'ripple', clipId: clip.id, edge: 'end' };
  return { mode: verticalFraction < 0.5 ? 'slip' : 'slide', clipId: clip.id };
}
