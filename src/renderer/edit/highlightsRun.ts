import type { Clip, MediaAsset } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { pairedClip } from '@renderer/components/Timeline/detachAudio';
import type { FrameRange } from '@renderer/edit/silences';
import { findHighlights, type Highlight } from './highlights';

/**
 * Running "best moments" against a real clip.
 *
 * The analysis itself is the app's own - detectSilences and detectScenes,
 * already used by Remove silences and Scene cuts. Nothing new is measured;
 * what is added is the judgement in edit/highlights and the two things a
 * person can do with the answer: mark them, or keep only them.
 */

/** The file a clip's sound is in: its own, or its detached partner's. */
export function soundSourceOf(clip: Clip, clips: Record<string, Clip>, assets: readonly MediaAsset[]): string | null {
  const owner = clip.audioDetached ? pairedClip(clips, clip.id) ?? clip : clip;
  const asset = assets.find((candidate) => candidate.uri === owner.sourceUri || candidate.audioUri === owner.sourceUri);
  return asset?.sourcePath ?? null;
}

export interface HighlightScan {
  highlights: Highlight[];
  /** Seconds of the FILE the clip covers, so results can be put back on the timeline. */
  from: number;
  to: number;
}

/**
 * Look for the best moments of a clip.
 *
 * The shot changes are asked for but not insisted on: an audio-only clip has
 * none, and a failure to read them is not a reason to give up on the silences,
 * which are what the judgement mostly rests on.
 */
export async function scanHighlights(
  clip: Clip,
  path: string,
  fps: number,
  options: { count: number; minSeconds: number; maxSeconds: number },
): Promise<HighlightScan | null> {
  const api = window.filmora;
  if (!api?.detectSilences) return null;
  const from = clip.sourceOffsetFrames / fps;
  const to = from + clip.durationFrames / fps;

  const silences = await api
    .detectSilences(path, { noiseDb: -38, minSeconds: 0.6, fromSeconds: from, toSeconds: to })
    .catch(() => null);
  if (!silences) return null;

  const cuts = await api
    .detectScenes?.(path, { threshold: 0.35, fromSeconds: from, toSeconds: to })
    .catch(() => [] as number[]);

  // The analysis speaks in seconds of the FILE; the judgement wants seconds
  // from the clip's own start, so everything is shifted once, here.
  const shifted = silences.map((one) => ({ start: one.start - from, end: one.end - from }));
  const highlights = findHighlights({
    duration: to - from,
    silences: shifted,
    cuts: (cuts ?? []).map((at) => at - from),
    count: options.count,
    minSeconds: options.minSeconds,
    maxSeconds: options.maxSeconds,
  });
  return { highlights, from, to };
}

/** Seconds from the clip's start to a frame on the timeline. */
const frameOf = (clip: Clip, seconds: number, fps: number): number => Math.round(clip.startFrame + seconds * fps);

/** A marker at the start of each moment, numbered, as one undo step. */
export function markHighlights(clip: Clip, highlights: Highlight[], fps: number, label: (index: number) => string): number {
  if (highlights.length === 0) return 0;
  const mark = useHistoryStore.getState().undoStack.length;
  highlights.forEach((one, index) => {
    useProjectStore.getState().addMarker(frameOf(clip, one.start, fps), label(index + 1));
  });
  useHistoryStore.getState().squash(mark, 'Best moments');
  return highlights.length;
}

/**
 * The stretches BETWEEN the moments: what has to go for only the highlights
 * to be left. Before the first, between each pair, and after the last.
 */
export function gapsBetween(clip: Clip, highlights: Highlight[], fps: number): FrameRange[] {
  const gaps: FrameRange[] = [];
  let at = 0;
  for (const one of highlights) {
    if (one.start > at) gaps.push({ from: frameOf(clip, at, fps), to: frameOf(clip, one.start, fps) });
    at = Math.max(at, one.end);
  }
  const length = clip.durationFrames / fps;
  if (at < length) gaps.push({ from: frameOf(clip, at, fps), to: frameOf(clip, length, fps) });
  return gaps.filter((gap) => gap.to > gap.from);
}

/**
 * Keep only the moments: everything between them comes out and what is left
 * closes up, so the clip becomes the highlights back to back.
 *
 * Done with the store's own `removeClipRanges`, the same call "Remove
 * silences" uses - it already cuts from the end backwards (a cut moves
 * everything after it) and already carries linked clips along. Writing a
 * second one of those would have been a second thing to get wrong.
 */
export function keepOnlyHighlights(clip: Clip, highlights: Highlight[], fps: number): number {
  const gaps = gapsBetween(clip, highlights, fps);
  if (highlights.length === 0 || gaps.length === 0) return 0;
  return useProjectStore.getState().removeClipRanges(clip.id, gaps);
}
