import type { Clip, Track } from '@shared/types';
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

/* -------------------------------------------------------------------------- */
/* Moving several clips together                                              */
/* -------------------------------------------------------------------------- */

export interface Placement {
  startFrame: number;
  trackId: string;
}

type TrackRow = Pick<Track, 'id' | 'locked' | 'type'>;

export interface GroupMoveOptions {
  /** The magnet: close the holes the group leaves behind. */
  ripple: boolean;
  /** Tracks in the order the timeline shows them, for moving up and down. */
  tracks: readonly TrackRow[];
  /** Whether a track can hold this clip - sound on audio tracks, pictures on the rest. */
  accepts(track: TrackRow, clip: Clip): boolean;
  /** The grabbed clip. Its track decides where the group lands; defaults to the earliest. */
  anchorId?: string;
}

/**
 * Put `length` frames at exactly `start` on a track: every clip that would
 * overlap it - including one that begins before `start` and runs into it -
 * moves along, and so does whatever that one then covers.
 */
export function insertAtExactly(others: readonly Clip[], start: number, length: number): Map<string, number> {
  const shifts = new Map<string, number>();
  let cursor = start + length;
  for (const clip of [...others].sort((a, b) => a.startFrame - b.startFrame)) {
    if (clipEndFrame(clip) <= start) continue;
    if (clip.startFrame >= cursor) break;
    shifts.set(clip.id, cursor);
    cursor += clip.durationFrames;
  }
  return shifts;
}

/**
 * Where every clip goes when a selection moves together.
 *
 * A group used to be refused outright the moment any clip in it touched one
 * that was not selected. With the magnet on, clips sit edge to edge, so almost
 * every group was frozen in place. It now moves by the rules a single clip
 * follows: the holes it leaves close (the magnet), and what it lands on moves
 * along instead of being covered (point 8).
 *
 * - Spacing inside the group is kept on every track at once, so a picture and
 *   its sound never slip apart. The grabbed clip's track decides the landing
 *   point with the same nearer-edge rule as a single clip; the other tracks
 *   follow it exactly and push whatever is in the way.
 * - The group changes tracks only if every clip has a track to go to that is
 *   unlocked and takes it; otherwise it moves in time only.
 * - Clips on locked tracks stay where they are.
 *
 * Worked out from `clips` as they were when the drag began, so a clip pushed
 * aside goes back when the group moves on. Returns only what changes.
 */
export function planGroupMove(
  clips: Record<string, Clip>,
  ids: readonly string[],
  deltaFrames: number,
  deltaTracks: number,
  options: GroupMoveOptions,
): Map<string, Placement> {
  const plan = new Map<string, Placement>();
  const locked = new Set(options.tracks.filter((track) => track.locked).map((track) => track.id));
  const moving = ids
    .map((id) => clips[id])
    .filter((clip): clip is Clip => clip !== undefined && !locked.has(clip.trackId));
  if (moving.length === 0) return plan;

  const groupStart = Math.min(...moving.map((clip) => clip.startFrame));
  const delta = Math.max(Math.round(deltaFrames), -groupStart);

  // Between tracks: all of the group, or none of it.
  const rows = Math.round(deltaTracks);
  const rowOf = new Map(options.tracks.map((track, index) => [track.id, index]));
  const shiftedTrack = (clip: Clip): TrackRow | undefined => {
    const row = rowOf.get(clip.trackId);
    return row === undefined ? undefined : options.tracks[row + rows];
  };
  const changeTracks =
    rows !== 0 &&
    moving.every((clip) => {
      const track = shiftedTrack(clip);
      return track !== undefined && !track.locked && options.accepts(track, clip);
    });
  const targetOf = (clip: Clip): string => (changeTracks ? (shiftedTrack(clip) as TrackRow).id : clip.trackId);

  // What stays behind, with the holes closed when the magnet is on.
  const movingIds = new Set(moving.map((clip) => clip.id));
  const survivors: Record<string, Clip> = {};
  for (const [id, clip] of Object.entries(clips)) if (!movingIds.has(id)) survivors[id] = clip;
  if (options.ripple) {
    for (const [id, start] of rippleDelete(clips, movingIds)) {
      if (survivors[id]) survivors[id] = { ...survivors[id], startFrame: start };
    }
  }

  // The group as one block per destination track, as offsets from its start.
  const blocks = new Map<string, { offset: number; length: number }>();
  for (const clip of moving) {
    const trackId = targetOf(clip);
    const from = clip.startFrame - groupStart;
    const to = clipEndFrame(clip) - groupStart;
    const block = blocks.get(trackId);
    if (!block) {
      blocks.set(trackId, { offset: from, length: to - from });
    } else {
      const end = Math.max(block.offset + block.length, to);
      block.offset = Math.min(block.offset, from);
      block.length = end - block.offset;
    }
  }

  const anchor =
    moving.find((clip) => clip.id === options.anchorId) ??
    moving.reduce((earliest, clip) => (clip.startFrame < earliest.startFrame ? clip : earliest));
  const anchorTrack = targetOf(anchor);
  const anchorBlock = blocks.get(anchorTrack) as { offset: number; length: number };
  const landing = insertIntoTrack(
    clipsOnTrackExcept(survivors, anchorTrack, movingIds),
    groupStart + delta + anchorBlock.offset,
    anchorBlock.length,
  ).startFrame;
  const newGroupStart = Math.max(0, landing - anchorBlock.offset);

  const pushed = new Map<string, number>();
  for (const [trackId, block] of blocks) {
    const others = clipsOnTrackExcept(survivors, trackId, movingIds);
    for (const [id, start] of insertAtExactly(others, newGroupStart + block.offset, block.length)) {
      pushed.set(id, start);
    }
  }

  for (const clip of moving) {
    const startFrame = newGroupStart + (clip.startFrame - groupStart);
    const trackId = targetOf(clip);
    if (startFrame !== clip.startFrame || trackId !== clip.trackId) plan.set(clip.id, { startFrame, trackId });
  }
  for (const [id, clip] of Object.entries(survivors)) {
    const startFrame = pushed.get(id) ?? clip.startFrame;
    if (startFrame !== clips[id].startFrame) plan.set(id, { startFrame, trackId: clip.trackId });
  }
  return plan;
}

/**
 * How far an arrow key has to move a selection to hop over the clip beside it.
 *
 * A frame at a time is right in free space. But a clip that touches its
 * neighbour cannot move a frame without covering it - and with the magnet on,
 * clips always touch - so a blocked nudge becomes a swap with that neighbour:
 * after it, or before it. Null when there is nothing on that side to hop over.
 */
export function nudgeHopDelta(
  clips: Record<string, Clip>,
  ids: readonly string[],
  direction: 1 | -1,
  ripple: boolean,
): number | null {
  const moving = ids.map((id) => clips[id]).filter((clip): clip is Clip => clip !== undefined);
  if (moving.length === 0) return null;

  const anchor = moving.reduce((earliest, clip) => (clip.startFrame < earliest.startFrame ? clip : earliest));
  const block = moving.filter((clip) => clip.trackId === anchor.trackId);
  const blockStart = Math.min(...block.map((clip) => clip.startFrame));
  const blockEnd = Math.max(...block.map(clipEndFrame));
  const others = clipsOnTrackExcept(clips, anchor.trackId, new Set(ids));

  if (direction > 0) {
    const next = others.filter((clip) => clip.startFrame >= blockEnd).sort((a, b) => a.startFrame - b.startFrame)[0];
    // With the magnet the hole closes first, so the neighbour will have moved
    // back by the block's length before the group lands after it.
    return next ? clipEndFrame(next) - (ripple ? blockEnd : blockStart) : null;
  }
  const previous = others
    .filter((clip) => clipEndFrame(clip) <= blockStart)
    .sort((a, b) => b.startFrame - a.startFrame)[0];
  return previous ? previous.startFrame - blockStart : null;
}
