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

function writePosition(clip: Clip, position: Keyframe<Vector2D>[], tracking: Clip['tracking']): void {
  const store = useProjectStore.getState();
  const own = { ...ownTransform(clip), position };
  const kept = clip.fx ? cleanFx(clip.fx) : undefined;
  if (kept && !fxIsEmpty(kept)) {
    store.updateClip(clip.id, { transform: composeFx(own, kept, clip, store.project, store.assets), fx: { ...kept, base: own }, tracking });
  } else {
    store.updateClip(clip.id, { transform: own, fx: undefined, tracking });
  }
}

/** Make the clip follow: `path` from `fromFrame` on; before it, the clip's own keyframes stay. */
export function applyFollow(clipId: string, path: Keyframe<Vector2D>[], fromFrame: number): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip || path.length === 0) return;
  const before = clip.tracking?.before ?? ownTransform(clip).position;
  const earlier = before.filter((key) => key.frame < fromFrame);
  writePosition(clip, [...earlier, ...path], { fromFrame, before });
}

/** Stop following: the clip's position as it was before. */
export function removeFollow(clipId: string): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip?.tracking) return;
  writePosition(clip, clip.tracking.before, undefined);
}
