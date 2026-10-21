import type { Clip, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { fitScale } from '@renderer/media/fitToFrame';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { buildMotionTransform, type MotionBase, type MotionPresetId } from './presets';
import { animationPhase, animationWindow, withAnimation, type ClipAnimationId } from './animations';

/**
 * Applying and removing the motion presets on a clip. Kept out of presets.ts
 * so the maths there stays free of the store and can be unit-tested on its own.
 *
 * A preset writes position and scale together as one undo step, the way the
 * inspector's "Reset" does, so a single Ctrl+Z takes the whole move off again.
 */

/** The clip's rest pose: the fit it was placed at (stills get bars, not a stretch), centred. */
function motionBase(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): MotionBase {
  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  const fit = asset ? fitScale(asset, project) : null;
  const scale: Vector2D = fit ?? { x: 1, y: 1 };
  return { scale, position: { x: 0, y: 0 } };
}

/** Put `preset` on the clip, replacing any position/scale animation already there. */
export function applyMotionPreset(clipId: string, preset: MotionPresetId): void {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return;
  const base = motionBase(clip, store.project, store.assets);
  const move = buildMotionTransform(preset, clip, store.project, base);
  store.updateClip(clipId, { transform: { ...clip.transform, position: move.position, scale: move.scale } });
}

/**
 * Put clip animation `id` (animations.ts) on the clip, as one undo step. It
 * rests on the pose the clip has where the animation meets it - the end of
 * an In, the start of an Out - so a clip moved or scaled stays so.
 */
export function applyClipAnimation(clipId: string, id: ClipAnimationId): void {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return;
  const { fps } = store.project;
  const window = animationWindow(id, clip, fps);
  const restFrame = animationPhase(id) === 'in' ? window.to : window.from;
  const pose = evaluateTransform(clip.transform, restFrame);
  const rest = { position: pose.position, scale: pose.scale, rotation: pose.rotation, opacity: pose.opacity };
  store.updateClip(clipId, { transform: withAnimation(clip.transform, id, window, rest, store.project, fps) });
}

/**
 * Take any screen move off the clip: position back to centred, scale back to
 * its fit. Rotation and opacity keyframes, which are no business of a motion
 * preset, are left untouched.
 */
export function clearMotionPreset(clipId: string): void {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return;
  const asset = store.assets.find((candidate) => candidate.uri === clip.sourceUri);
  const fit = asset ? fitScale(asset, store.project) : null;
  store.updateClip(clipId, {
    transform: {
      ...clip.transform,
      position: [],
      // A still keeps its fit; footage that fills the frame goes back to a clean, keyframe-free scale.
      scale: fit ? [{ id: `kf-fit-${clipId}`, frame: clip.startFrame, value: fit, easing: 'linear' }] : [],
    },
  });
}
