import type { Clip } from '@shared/types';
import { speedOf } from '@renderer/timing/clipSpeed';
import { clipEndFrame, splitClip } from '@renderer/components/Timeline/timelineOps';
import { regroupCopies, tidyLinkGroups } from '@renderer/components/Timeline/linkGroups';
import { clipSourceSeconds } from './silences';

/**
 * "Split at scene changes": a clip cut wherever its picture changes shot, so
 * a long recording with several takes in it becomes one clip a take - to
 * reorder, trim or drop - as Resolve's Scene Cut Detection and Premiere's
 * Scene Edit Detection do.
 *
 * Where the shots change comes from the file (main/media/scenes.ts); this
 * turns those seconds into frames of the timeline and makes the cuts, on the
 * clip and what is linked to it. Pure: the store runs it as one undo step.
 */

/** The timeline frames inside `clip` where its file changes shot: two frames clear of either end. */
export function sceneCutFrames(clip: Clip, cuts: readonly number[], fps: number): number[] {
  const span = clipSourceSeconds(clip, fps);
  const speed = speedOf(clip);
  const end = clipEndFrame(clip);
  const frames = cuts
    .filter((at) => at > span.from && at < span.to)
    .map((at) => Math.round(clip.startFrame + ((at - span.from) * fps) / speed))
    .filter((frame) => frame >= clip.startFrame + 2 && frame <= end - 2);
  return [...new Set(frames)].sort((a, b) => a - b);
}

/**
 * `clips` with the clips in `group` (a clip and those linked to it) cut at
 * each of `frames`; the pieces between two cuts are linked to each other, as
 * a razor cut leaves them.
 */
export function splitAtFrames(clips: Record<string, Clip>, group: readonly string[], frames: readonly number[]): { clips: Record<string, Clip>; pieces: number } {
  const next = { ...clips };
  const members = new Set(group.filter((id) => clips[id]));
  let cuts = 0;
  for (const frame of [...frames].sort((a, b) => a - b)) {
    const rights: Clip[] = [];
    for (const id of [...members]) {
      const clip = next[id];
      if (!clip) continue;
      const halves = splitClip(clip, frame);
      if (!halves) continue;
      next[halves[0].id] = halves[0];
      rights.push(halves[1]);
    }
    if (rights.length === 0) continue;
    cuts += 1;
    for (const right of regroupCopies(rights)) {
      next[right.id] = right;
      members.add(right.id);
    }
  }
  return { clips: tidyLinkGroups(next), pieces: cuts + 1 };
}
