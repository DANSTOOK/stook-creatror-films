import type { Clip, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { fitScale } from '@renderer/media/fitToFrame';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { buildMotionTransform, type MotionBase, type MotionPresetId } from './presets';

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

/** Whether the clip is carrying position or scale keyframes (a motion preset, or a hand-made move). */
export function hasMotion(clip: Clip): boolean {
  return clip.transform.position.length > 0 || clip.transform.scale.length > 1;
}
