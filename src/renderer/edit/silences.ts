import type { Clip } from '@shared/types';
import { speedOf, isReversed } from '@renderer/timing/clipSpeed';
import { clipEndFrame, moveClip, splitClip } from '@renderer/components/Timeline/timelineOps';
import { regroupCopies, tidyLinkGroups } from '@renderer/components/Timeline/linkGroups';

/**
 * "Remove silences": the quiet stretches of a clip's sound taken out of the
 * clip - and out of whatever is linked to it, its picture or its sound - and
 * what follows on those tracks closed up behind, as a jump cut does.
 *
 * Where it is quiet comes from the file (main/media/silence.ts); this turns
 * those seconds of the file into frames of the timeline, keeps a little of
 * each silence either side so words are not clipped, and makes the cuts.
 * Pure: the store runs it as one undo step.
 */

/** Frames of the timeline, the first in, the last out: [from, to). */
export interface FrameRange {
  from: number;
  to: number;
}

/** The seconds of its file a clip plays, start to end. */
export function clipSourceSeconds(clip: Pick<Clip, 'sourceOffsetFrames' | 'durationFrames' | 'speed'>, fps: number): { from: number; to: number } {
  const from = clip.sourceOffsetFrames / fps;
  return { from, to: from + (clip.durationFrames * speedOf(clip)) / fps };
}

/** Whether silences can be taken out of a clip: played forwards (a reversed clip runs its file backwards). */
export const canRemoveSilences = (clip: Clip): boolean => !isReversed(clip) && !clip.caption && !clip.title;

/**
 * The frames of the timeline to take out of `clip`, for silences found in its
 * file: each kept `padSeconds` short at either end, so the words around it
 * are left whole - except at the clip's own start and end, where a silence
 * goes entirely. Under two frames is not worth a cut.
 */
export function silenceRanges(clip: Clip, silences: ReadonlyArray<{ start: number; end: number }>, fps: number, padSeconds: number): FrameRange[] {
  const span = clipSourceSeconds(clip, fps);
  const speed = speedOf(clip);
  const end = clipEndFrame(clip);
  const toFrame = (seconds: number): number => Math.round(clip.startFrame + ((seconds - span.from) * fps) / speed);
  const edge = 0.5 / fps;
  const ranges: FrameRange[] = [];
  for (const silence of silences) {
    const start = Math.max(span.from, silence.start);
    const stop = Math.min(span.to, silence.end);
    if (stop <= start) continue;
    const from = start <= span.from + edge ? clip.startFrame : toFrame(start + padSeconds);
    const to = stop >= span.to - edge ? end : toFrame(stop - padSeconds);
    const range = { from: Math.max(clip.startFrame, from), to: Math.min(end, to) };
    if (range.to - range.from >= 2) ranges.push(range);
  }
  // In order, and any that touch made one.
  ranges.sort((a, b) => a.from - b.from);
  const merged: FrameRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * `clips` with `ranges` taken out of the clips in `group` (a clip and those
 * linked to it), and every clip after each range on those clips' tracks
 * moved back by its length. A clip a range runs through is cut either side
 * and the piece inside dropped; the pieces after a cut are linked to each
 * other, as a razor cut leaves them. Returns the clips and how many frames
 * came out.
 */
export function removeRanges(clips: Record<string, Clip>, group: readonly string[], ranges: readonly FrameRange[]): { clips: Record<string, Clip>; removed: number } {
  let next = { ...clips };
  const tracks = new Set(group.map((id) => clips[id]?.trackId).filter((id): id is string => Boolean(id)));
  const members = new Set(group.filter((id) => clips[id]));
  let removed = 0;

  // Last first, so a cut never moves a range still to come.
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    const length = range.to - range.from;
    if (length <= 0) continue;
    const rights: Clip[] = [];
    let cut = false;
    for (const id of [...members]) {
      const clip = next[id];
      if (!clip) continue;
      const start = clip.startFrame;
      const end = clipEndFrame(clip);
      if (end <= range.from || start >= range.to) continue;
      cut = true;
      delete next[id];
      members.delete(id);
      if (start < range.from) {
        const halves = splitClip(clip, range.from);
        if (halves) {
          next[halves[0].id] = halves[0];
          members.add(halves[0].id);
        }
      }
      if (end > range.to) {
        const halves = splitClip(clip, range.to);
        if (halves) rights.push(halves[1]);
      }
    }
    if (!cut) continue;
    for (const right of regroupCopies(rights)) {
      next[right.id] = right;
      members.add(right.id);
    }
    // What came after, on these tracks, closes up.
    for (const clip of Object.values(next)) {
      if (tracks.has(clip.trackId) && clip.startFrame >= range.to) next[clip.id] = moveClip(clip, clip.startFrame - length);
    }
    removed += length;
  }
  next = tidyLinkGroups(next);
  return { clips: next, removed };
}
