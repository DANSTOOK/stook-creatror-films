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

/**
 * Re-express a whole project on a different frame rate.
 *
 * Frame numbers are meaningless without the rate that interprets them, so
 * changing `fps` without touching anything else silently re-times the edit: a
 * cut authored at second 4 on a 24 fps timeline lands at second 1.6 once the
 * project is read as 60 fps. Every frame-valued field is therefore rescaled by
 * `next / previous`, which keeps the edit at the same WALL-CLOCK positions and
 * only changes the grid it is measured on.
 *
 * Durations are floored at one frame: rounding 1 frame of 60 fps material down
 * to 0 at 24 fps would delete the clip outright.
 */
export function retimeProject(project: ProjectState, nextFps: number): ProjectState {
  const previous = project.fps;
  if (!Number.isFinite(nextFps) || nextFps <= 0 || nextFps === previous) {
    return { ...project, fps: Number.isFinite(nextFps) && nextFps > 0 ? nextFps : previous };
  }

  const ratio = nextFps / previous;
  const scale = (frames: number): number => Math.round(frames * ratio);
  const scaleKeyframes = <T extends KeyframeValue>(track: Keyframe<T>[]): Keyframe<T>[] =>
    track.map((keyframe) => ({ ...keyframe, frame: scale(keyframe.frame) }));

  return {
    ...project,
    fps: nextFps,
    durationFrames: Math.max(1, scale(project.durationFrames)),
    currentFrame: scale(project.currentFrame),
    markers: project.markers.map((marker) => ({ ...marker, frame: scale(marker.frame) })),
    clips: Object.fromEntries(
      Object.entries(project.clips).map(([id, clip]) => [
        id,
        {
          ...clip,
          startFrame: scale(clip.startFrame),
          durationFrames: Math.max(1, scale(clip.durationFrames)),
          sourceOffsetFrames: scale(clip.sourceOffsetFrames),
          transform: {
            ...clip.transform,
            position: scaleKeyframes(clip.transform.position),
            scale: scaleKeyframes(clip.transform.scale),
            rotation: scaleKeyframes(clip.transform.rotation),
            opacity: scaleKeyframes(clip.transform.opacity),
          },
        },
      ]),
    ),
  };
}

/**
 * The order clips on one track are painted in - later ones on top, and the
 * selection above everything else so the clip being worked on is never hidden.
 *
 * Hit-testing walks this same list BACKWARDS, so a click lands on the clip
 * that is visibly on top. It used to walk clips by start frame and stop at the
 * first match while painting in insertion order, so with two clips stacked
 * only the one behind could ever be selected.
 */
export function clipsInPaintOrder(
  project: ProjectState,
  trackId: string,
  selectedIds: Iterable<string> = [],
): Clip[] {
  const selected = new Set(selectedIds);
  return Object.values(project.clips)
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => {
      const bySelection = Number(selected.has(a.id)) - Number(selected.has(b.id));
      return bySelection !== 0 ? bySelection : a.startFrame - b.startFrame || a.id.localeCompare(b.id);
    });
}
