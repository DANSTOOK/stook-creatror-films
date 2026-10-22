import type { Clip, ClipMotionFx, ClipTransform, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { fitScale } from '@renderer/media/fitToFrame';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { type MotionPresetId } from './presets';
import { cleanFx, composeFx, fxIsEmpty } from './compose';
import {
  animationPhase,
  animationSeconds,
  animationWindow,
  isClipAnimation,
  withoutAnimation,
  type ClipAnimationId,
} from './animations';

/**
 * Putting screen moves (presets.ts) and clip animations (animations.ts) on a
 * clip, changing them, and taking them off. Kept out of the maths modules so
 * those stay free of the store and can be unit-tested on their own.
 *
 * What was chosen is kept on the clip (`clip.fx`), with the transform the
 * clip had before any of it (`fx.base`), and every change goes through
 * setClipFx: the transform is made again from that base with the new choice
 * on it (compose.ts) - move first, then the loop, then the In and the Out on
 * top - as one undo step. So the inspector's Effects tab can show what is on
 * a clip and change any of it, and a single Ctrl+Z takes back each change.
 */

const CENTRE: Vector2D = { x: 0.5, y: 0.5 };

/** Position and scale with no move on them: centred, at the clip's fit. */
function restingMove(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): Pick<ClipTransform, 'position' | 'scale'> {
  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  const fit = asset ? fitScale(asset, project) : null;
  return {
    position: [],
    // A still keeps its fit; footage that fills the frame goes back to a clean, keyframe-free scale.
    scale: fit ? [{ id: `kf-fit-${clip.id}`, frame: clip.startFrame, value: fit, easing: 'linear' }] : [],
  };
}

const restingProjects = new WeakMap<ProjectState, { clipId: string; project: ProjectState }>();

/**
 * The project with one clip's move taken off - centred, at its fit - for the
 * viewer to draw while that clip's zoom zone is being picked: the zone is a
 * part of the picture as it is, so the picture under it must not be zoomed.
 * The same object for as long as the project is, so the viewer's caches hold.
 */
export function withClipAtRest(project: ProjectState, assets: readonly MediaAsset[], clipId: string): ProjectState {
  const known = restingProjects.get(project);
  if (known && known.clipId === clipId) return known.project;
  const clip = project.clips[clipId];
  if (!clip) return project;
  const resting = { ...project, clips: { ...project.clips, [clipId]: { ...clip, transform: { ...clip.transform, ...restingMove(clip, project, assets) } } } };
  restingProjects.set(project, { clipId, project: resting });
  return resting;
}

const PHASES = ['loop', 'in', 'out'] as const;

/** The frames an animation choice on a clip covers. */
function windowOf(id: ClipAnimationId, clip: Clip, fps: number, seconds?: number): { from: number; to: number } {
  return animationWindow(id, clip, fps, animationPhase(id) === 'loop' ? undefined : seconds);
}

/** Whether anything is chosen at all. */
export const hasClipFx = (fx: ClipMotionFx | undefined): boolean => Boolean(fx && (fx.motion || fx.in || fx.out || fx.loop));

/**
 * Make `next` what is on the clip: the keyframes `clip.fx` wrote taken out,
 * `next`'s written in, as one undo step. `mergeKey` lets a slider being
 * dragged make one undo step of the whole drag.
 */
export function setClipFx(clipId: string, next: ClipMotionFx, mergeKey?: string): void {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return;
  const { project, assets } = store;
  const base = clip.fx?.base ?? legacyBase(clip, project, assets);
  const kept = cleanFx(next);
  if (fxIsEmpty(kept)) {
    // Nothing on it any more: the clip as it was before any of it.
    store.updateClip(clipId, { transform: base, fx: undefined }, mergeKey);
    return;
  }
  store.updateClip(clipId, { transform: composeFx(base, kept, clip, project, assets), fx: { ...kept, base } }, mergeKey);
}

/**
 * The transform a clip had before its move and animations, for one saved
 * before that was kept (v1.56 to v1.61): its tracks with what the old choice
 * wrote taken out again - and a move's position and scale put back to rest.
 */
function legacyBase(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): ClipTransform {
  const old = clip.fx;
  if (!old) return clip.transform;
  let transform = clip.transform;
  for (const phase of PHASES) {
    const chosen = old[phase];
    if (chosen && isClipAnimation(chosen.id)) {
      transform = withoutAnimation(transform, chosen.id, windowOf(chosen.id, clip, project.fps, 'seconds' in chosen ? chosen.seconds : undefined));
    }
  }
  return old.motion ? { ...transform, ...restingMove(clip, project, assets) } : transform;
}

/** Put `preset` on the clip at its own strength, zooming to the centre; it replaces any move already there. */
export function applyMotionPreset(clipId: string, preset: MotionPresetId): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip) return;
  setClipFx(clipId, { ...clip.fx, motion: { preset, amount: 1, focus: CENTRE } });
}

/**
 * Put clip animation `id` on the clip, at its own length: it takes the place
 * of the clip's In, Out or Loop, whichever it is.
 */
export function applyClipAnimation(clipId: string, id: ClipAnimationId): void {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip) return;
  const phase = animationPhase(id);
  setClipFx(clipId, { ...clip.fx, [phase]: phase === 'loop' ? { id } : { id, seconds: animationSeconds(id) } });
}

/**
 * Take any screen move off the clip: position back to centred, scale back to
 * its fit. Animations stay, written again over the still clip.
 */
export function clearMotionPreset(clipId: string): void {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return;
  if (clip.fx?.motion) {
    const { motion: _gone, ...rest } = clip.fx;
    void _gone;
    setClipFx(clipId, rest);
    return;
  }
  store.updateClip(clipId, { transform: { ...clip.transform, ...restingMove(clip, store.project, store.assets) } });
}
