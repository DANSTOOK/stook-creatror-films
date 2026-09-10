import type { Clip, Keyframe, KeyframeValue, ProjectState, Vector2D } from '@shared/types';
import { createId } from '@shared/utils/id';
import { evaluateKeyframes } from '@renderer/engine/KeyframeEvaluator';

/**
 * Pure timeline editing operations.
 *
 * Keyframe times are stored in TIMELINE space, not clip-relative space, which
 * is why moving a clip shifts its keyframes and splitting a clip partitions
 * them. Keeping the convention in one place is what lets the razor tool
 * guarantee that a cut is visually invisible: both halves get a boundary
 * keyframe carrying the interpolated value at the cut.
 */

export const clipEndFrame = (clip: Clip): number => clip.startFrame + clip.durationFrames;

export const clipContainsFrame = (clip: Clip, frame: number): boolean =>
  frame >= clip.startFrame && frame < clipEndFrame(clip);

export const clipsOverlap = (a: Clip, b: Clip): boolean =>
  a.trackId === b.trackId && a.startFrame < clipEndFrame(b) && b.startFrame < clipEndFrame(a);

function cloneValue<T extends KeyframeValue>(value: T): T {
  // A generic parameter blocks narrowing, so the vector branch is cast.
  return typeof value === 'number' ? value : ({ ...(value as Vector2D) } as T);
}

function cloneKeyframe<T extends KeyframeValue>(keyframe: Keyframe<T>): Keyframe<T> {
  return {
    ...keyframe,
    id: createId('kf'),
    value: cloneValue(keyframe.value),
    ...(keyframe.bezierParams
      ? {
          bezierParams: {
            cp1: { ...keyframe.bezierParams.cp1 },
            cp2: { ...keyframe.bezierParams.cp2 },
          },
        }
      : {}),
  };
}

/**
 * Partition one animated property at `frame`.
 *
 * A boundary keyframe holding the interpolated value is inserted on whichever
 * side needs it, so neither half jumps at the cut.
 */
export function splitKeyframeTrack<T extends KeyframeValue>(
  track: Keyframe<T>[],
  frame: number,
): [Keyframe<T>[], Keyframe<T>[]] {
  if (track.length === 0) return [[], []];

  const sorted = [...track].sort((a, b) => a.frame - b.frame);
  const left = sorted.filter((keyframe) => keyframe.frame < frame).map(cloneKeyframe);
  const right = sorted.filter((keyframe) => keyframe.frame >= frame).map(cloneKeyframe);

  const boundaryValue = evaluateKeyframes(sorted, frame, sorted[0].value);

  if (left.length > 0 && right.length > 0) {
    left.push({
      id: createId('kf'),
      frame,
      value: boundaryValue,
      easing: 'linear',
    });
    right.unshift({
      id: createId('kf'),
      frame,
      value: boundaryValue,
      easing: left[left.length - 1].easing,
    });
  }

  return [left, right];
}

function splitTransform(clip: Clip, frame: number): [Clip['transform'], Clip['transform']] {
  const [positionLeft, positionRight] = splitKeyframeTrack(clip.transform.position, frame);
  const [scaleLeft, scaleRight] = splitKeyframeTrack(clip.transform.scale, frame);
  const [rotationLeft, rotationRight] = splitKeyframeTrack(clip.transform.rotation, frame);
  const [opacityLeft, opacityRight] = splitKeyframeTrack(clip.transform.opacity, frame);

  return [
    {
      position: positionLeft,
      scale: scaleLeft,
      rotation: rotationLeft,
      opacity: opacityLeft,
      anchorPoint: { ...clip.transform.anchorPoint },
    },
    {
      position: positionRight,
      scale: scaleRight,
      rotation: rotationRight,
      opacity: opacityRight,
      anchorPoint: { ...clip.transform.anchorPoint },
    },
  ];
}

/**
 * Razor tool: split `clip` at `frame` into two independent clips.
 *
 * Returns `null` when the cut lands on or outside a boundary, since that would
 * produce a zero-length clip. The left half keeps the original id so selection
 * and undo remain stable; the right half is a new clip.
 */
export function splitClip(clip: Clip, frame: number): [Clip, Clip] | null {
  if (frame <= clip.startFrame || frame >= clipEndFrame(clip)) return null;

  const leftDuration = frame - clip.startFrame;
  const rightDuration = clip.durationFrames - leftDuration;
  const [leftTransform, rightTransform] = splitTransform(clip, frame);

  const left: Clip = {
    ...structuredClone(clip),
    durationFrames: leftDuration,
    transform: leftTransform,
  };

  const right: Clip = {
    ...structuredClone(clip),
    id: createId('clip'),
    startFrame: frame,
    durationFrames: rightDuration,
    sourceOffsetFrames: clip.sourceOffsetFrames + leftDuration,
    transform: rightTransform,
  };

  return [left, right];
}

/** Shift every keyframe on a clip by `delta` timeline frames. */
export function shiftClipKeyframes(clip: Clip, delta: number): Clip {
  if (delta === 0) return clip;

  const shift = <T extends KeyframeValue>(track: Keyframe<T>[]): Keyframe<T>[] =>
    track.map((keyframe) => ({ ...keyframe, frame: keyframe.frame + delta }));

  return {
    ...clip,
    transform: {
      ...clip.transform,
      position: shift(clip.transform.position),
      scale: shift(clip.transform.scale),
      rotation: shift(clip.transform.rotation),
      opacity: shift(clip.transform.opacity),
    },
  };
}

/** Move a clip so it starts at `startFrame`, dragging its keyframes with it. */
export function moveClip(clip: Clip, startFrame: number, trackId = clip.trackId): Clip {
  const target = Math.max(0, Math.round(startFrame));
  const moved = shiftClipKeyframes(clip, target - clip.startFrame);
  return { ...moved, startFrame: target, trackId };
}

/**
 * Trim the head of a clip. The source offset advances with the edit so the
 * remaining media stays anchored to the same footage.
 */
export function trimClipStart(clip: Clip, startFrame: number): Clip {
  const end = clipEndFrame(clip);
  const target = Math.min(Math.max(0, Math.round(startFrame)), end - 1);
  const delta = target - clip.startFrame;

  return {
    ...clip,
    startFrame: target,
    durationFrames: clip.durationFrames - delta,
    sourceOffsetFrames: Math.max(0, clip.sourceOffsetFrames + delta),
  };
}

/** Trim the tail of a clip. */
export function trimClipEnd(clip: Clip, endFrame: number): Clip {
  const target = Math.max(clip.startFrame + 1, Math.round(endFrame));
  return { ...clip, durationFrames: target - clip.startFrame };
}

export const clipsOnTrack = (project: ProjectState, trackId: string): Clip[] =>
  Object.values(project.clips)
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);

/** The clip under the playhead on a given track, if any. */
export const clipAtFrame = (
  project: ProjectState,
  trackId: string,
  frame: number,
): Clip | undefined =>
  clipsOnTrack(project, trackId).find((clip) => clipContainsFrame(clip, frame));

/** Longest clip end across the project, used to size the timeline. */
export function projectContentLength(project: ProjectState): number {
  let longest = 0;
  for (const clip of Object.values(project.clips)) {
    longest = Math.max(longest, clipEndFrame(clip));
  }
  return longest;
}
