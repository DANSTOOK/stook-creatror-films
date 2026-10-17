import type { Clip, ProjectState } from '@shared/types';

/**
 * What loop playback goes round.
 *
 * The way the others decide it, in order:
 *
 * - **In to Out**, when either mark is set - Premiere loops between them,
 *   Resolve's Loop with marks set plays In to Out over and over, and Final
 *   Cut's Loop Playback repeats a range selection.
 * - **The selected clips**, from the first one's start to the last one's end -
 *   Final Cut's Play Selection with Loop Playback on: pick a clip, hear it
 *   again and again.
 * - **The whole edit** otherwise: from the start to the end of the last clip.
 *   It used to go round the project's canvas length, which a new project sets
 *   to a minute and only ever grows - so a 19-second edit played 41 seconds
 *   of black before it came round.
 *
 * Frames, `start` included and `end` not, like every range in the editor.
 */

export type LoopSource = 'marks' | 'selection' | 'timeline';

export interface LoopRange {
  start: number;
  end: number;
  source: LoopSource;
}

export interface LoopInputs {
  inFrame: number | null;
  outFrame: number | null;
  selectedClipIds: readonly string[];
}

/** The end of the last clip, or the canvas when there are none. */
function editEnd(project: Pick<ProjectState, 'clips' | 'durationFrames'>): number {
  let end = 0;
  for (const clip of Object.values(project.clips)) end = Math.max(end, clip.startFrame + clip.durationFrames);
  return end > 0 ? end : Math.max(1, project.durationFrames);
}

export function loopRangeOf(project: Pick<ProjectState, 'clips' | 'durationFrames'>, ui: LoopInputs): LoopRange {
  if (ui.inFrame !== null || ui.outFrame !== null) {
    const start = Math.max(0, Math.round(ui.inFrame ?? 0));
    const end = Math.round(ui.outFrame ?? editEnd(project));
    if (end - start >= 1) return { start, end, source: 'marks' };
  }

  const picked = ui.selectedClipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip));
  if (picked.length > 0) {
    const start = Math.min(...picked.map((clip) => clip.startFrame));
    const end = Math.max(...picked.map((clip) => clip.startFrame + clip.durationFrames));
    if (end - start >= 1) return { start, end, source: 'selection' };
  }

  return { start: 0, end: editEnd(project), source: 'timeline' };
}

/*
  The clock asks on every frame of playback, so the answer is kept until
  something it depends on changes: the clips, the selection or the marks.
*/
let cached: { clips: ProjectState['clips']; duration: number; ui: LoopInputs; range: LoopRange } | null = null;

/** `loopRangeOf`, remembered between calls with the same clips, selection and marks. */
export function currentLoopRange(project: Pick<ProjectState, 'clips' | 'durationFrames'>, ui: LoopInputs): LoopRange {
  if (
    cached &&
    cached.clips === project.clips &&
    cached.duration === project.durationFrames &&
    cached.ui.inFrame === ui.inFrame &&
    cached.ui.outFrame === ui.outFrame &&
    cached.ui.selectedClipIds === ui.selectedClipIds
  ) {
    return cached.range;
  }
  const range = loopRangeOf(project, ui);
  cached = { clips: project.clips, duration: project.durationFrames, ui: { inFrame: ui.inFrame, outFrame: ui.outFrame, selectedClipIds: ui.selectedClipIds }, range };
  return range;
}

/** Whether a frame is inside a loop, where playback going round it may start. */
export const insideLoop = (range: Pick<LoopRange, 'start' | 'end'>, frame: number): boolean =>
  frame >= range.start && frame < range.end;
