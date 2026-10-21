import type { Clip, ClipMotionFx, ClipTransform, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { fitScale } from '@renderer/media/fitToFrame';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { buildMotionTransform, isMotionPreset, type MotionBase, type MotionPresetId } from './presets';
import {
  animationPhase,
  animationSeconds,
  animationWindow,
  isClipAnimation,
  withAnimation,
  withoutAnimation,
  type ClipAnimationId,
} from './animations';

/**
 * Putting screen moves (presets.ts) and clip animations (animations.ts) on a
 * clip, changing them, and taking them off. Kept out of the maths modules so
 * those stay free of the store and can be unit-tested on their own.
 *
 * What was chosen is kept on the clip (`clip.fx`), and every change goes
 * through setClipFx: the keyframes the old choice wrote come out, the new
 * choice's go in - move first, then the loop, then the In and the Out on
 * top - as one undo step. So the inspector's Effects tab can show what is on
 * a clip and change any of it, and a single Ctrl+Z takes back each change.
 */

const CENTRE: Vector2D = { x: 0.5, y: 0.5 };

/** The clip's rest pose: the fit it was placed at (stills get bars, not a stretch), centred. */
function motionBase(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): MotionBase {
  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  const fit = asset ? fitScale(asset, project) : null;
  const scale: Vector2D = fit ?? { x: 1, y: 1 };
  return { scale, position: { x: 0, y: 0 } };
}

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
  const { fps } = project;
  const old = clip.fx ?? {};
  let transform = clip.transform;

  // Out with what the old choice wrote.
  for (const phase of PHASES) {
    const chosen = old[phase];
    if (chosen && isClipAnimation(chosen.id)) {
      transform = withoutAnimation(transform, chosen.id, windowOf(chosen.id, clip, fps, 'seconds' in chosen ? chosen.seconds : undefined));
    }
  }
  // The move: written whole, or taken off.
  if (next.motion && isMotionPreset(next.motion.preset)) {
    const move = buildMotionTransform(next.motion.preset, clip, project, motionBase(clip, project, assets), {
      amount: next.motion.amount,
      focus: next.motion.focus,
    });
    transform = { ...transform, position: move.position, scale: move.scale };
  } else if (old.motion) {
    transform = { ...transform, ...restingMove(clip, project, assets) };
  }
  // The animations on top, each resting on the pose the clip has where it meets it.
  for (const phase of PHASES) {
    const chosen = next[phase];
    if (!chosen || !isClipAnimation(chosen.id) || animationPhase(chosen.id) !== phase) continue;
    const window = windowOf(chosen.id, clip, fps, 'seconds' in chosen ? chosen.seconds : undefined);
    const pose = evaluateTransform(transform, phase === 'in' ? window.to : window.from);
    const rest = { position: pose.position, scale: pose.scale, rotation: pose.rotation, opacity: pose.opacity };
    transform = withAnimation(transform, chosen.id, window, rest, project, fps);
  }

  const kept: ClipMotionFx = {};
  if (next.motion && isMotionPreset(next.motion.preset)) kept.motion = next.motion;
  for (const phase of PHASES) {
    const chosen = next[phase];
    if (chosen && isClipAnimation(chosen.id) && animationPhase(chosen.id) === phase) (kept as Record<string, unknown>)[phase] = chosen;
  }
  store.updateClip(clipId, { transform, fx: hasClipFx(kept) ? kept : undefined }, mergeKey);
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
