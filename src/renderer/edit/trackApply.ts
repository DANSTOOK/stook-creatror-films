import type { Clip, ClipTransform, Keyframe, Vector2D } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { cleanFx, composeFx, fxIsEmpty } from '@renderer/fx/motion/compose';
import { legacyBase } from '@renderer/fx/motion/apply';

/**
 * Writing a follow onto a clip, and taking it off: the position keyframes go
 * where the clip's own position lives - its fx.base when a move or an
 * animation is on it, which is then put back on top - so a sticker that pops
 * in and pulses still pops in and pulses, wherever the thing has gone.
 * One undo step either way.
 */

/** The transform the clip's own position lives in: its base when it has effects on it. */
function ownTransform(clip: Clip): ClipTransform {
  const store = useProjectStore.getState();
  return clip.fx ? (clip.fx.base ?? legacyBase(clip, store.project, store.assets)) : clip.transform;
}

/** Where the clip is, of its own, at `frame`: what a follow starts from. */
export function followOrigin(clip: Clip, frame: number): Vector2D {
  return evaluateTransform(ownTransform(clip), frame).position;
}

/** The clip's own rotation at `frame`: what a follow that takes the turn starts from. */
export function followOwnRotation(clip: Clip, frame: number): number {
  return evaluateTransform(ownTransform(clip), frame).rotation;
}

/** The clip's own size at `frame`: what a follow that takes size starts from. */
export function followOwnScale(clip: Clip, frame: number): Vector2D {
  return evaluateTransform(ownTransform(clip), frame).scale;
}

function writePosition(clip: Clip, position: Keyframe<Vector2D>[], tracking: Clip['tracking'], scale?: Keyframe<Vector2D>[], rotation?: Keyframe<number>[]): void {
  const store = useProjectStore.getState();
  const own = { ...ownTransform(clip), position, ...(scale ? { scale } : {}), ...(rotation ? { rotation } : {}) };
  const kept = clip.fx ? cleanFx(clip.fx) : undefined;
  if (kept && !fxIsEmpty(kept)) {
    store.updateClip(clip.id, { transform: composeFx(own, kept, clip, store.project, store.assets), fx: { ...kept, base: own }, tracking });
  } else {
    store.updateClip(clip.id, { transform: own, fx: undefined, tracking });
  }
}

/**
 * Make the clip follow: `path` from `fromFrame` on, and `sizes` and `turns`
 * too when the follow takes them; before it, the clip's own keyframes stay.
 * What it had of its own before any follow is kept, to go back to.
 */
export function applyFollow(
  clipId: string,
  path: Keyframe<Vector2D>[],
  fromFrame: number,
  sizes?: Keyframe<Vector2D>[],
  turns?: Keyframe<number>[],
): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip || path.length === 0) return;
  const own = ownTransform(clip);
  const before = clip.tracking?.before ?? own.position;
  const beforeScale = clip.tracking?.beforeScale ?? (sizes && sizes.length > 0 ? own.scale : undefined);
  const beforeRotation = clip.tracking?.beforeRotation ?? (turns && turns.length > 0 ? own.rotation : undefined);
  const earlier = before.filter((key) => key.frame < fromFrame);
  const scale = sizes && sizes.length > 0 && beforeScale ? [...beforeScale.filter((key) => key.frame < fromFrame), ...sizes] : beforeScale;
  const rotation = turns && turns.length > 0 && beforeRotation ? [...beforeRotation.filter((key) => key.frame < fromFrame), ...turns] : beforeRotation;
  writePosition(
    clip,
    [...earlier, ...path],
    { fromFrame, before, ...(beforeScale ? { beforeScale } : {}), ...(beforeRotation ? { beforeRotation } : {}) },
    scale,
    rotation,
  );
}

/** Stop following: the clip's position as it was before. */
export function removeFollow(clipId: string): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip?.tracking) return;
  writePosition(clip, clip.tracking.before, undefined, clip.tracking.beforeScale, clip.tracking.beforeRotation);
}
