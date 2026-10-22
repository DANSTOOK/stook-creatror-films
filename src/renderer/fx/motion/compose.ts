import type { Clip, ClipMotionFx, ClipTransform, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { fitScale } from '@renderer/media/fitToFrame';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { buildMotionTransform, isMotionPreset, type MotionBase } from './presets';
import { animationPhase, animationWindow, isClipAnimation, withAnimation, type ClipAnimationId } from './animations';

/**
 * A clip's transform with its move and animations on it, from the transform
 * it had before any of them (Clip.fx.base): the move written over position
 * and scale, then the loop, then the In and the Out, each resting on the
 * pose the clip has where it meets it.
 *
 * Always from that base, never by taking an old animation's keyframes back
 * out: those keyframes may have covered the clip's own (a still's fit, a
 * sticker's size), and taking them out took the clip's own with them.
 * Pure, so the store's actions - setClipFx, a reframe - share it.
 */

const PHASES = ['loop', 'in', 'out'] as const;

/** The clip's rest pose for a move: the fit it was placed at (stills get bars, not a stretch), centred. */
function motionBase(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): MotionBase {
  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  const fit = asset ? fitScale(asset, project) : null;
  const scale: Vector2D = fit ?? { x: 1, y: 1 };
  return { scale, position: { x: 0, y: 0 } };
}

/** Only what this build can play: a known move, and each animation in its own slot. */
export function cleanFx(fx: ClipMotionFx | undefined): Omit<ClipMotionFx, 'base'> {
  const kept: Omit<ClipMotionFx, 'base'> = {};
  if (!fx) return kept;
  if (fx.motion && isMotionPreset(fx.motion.preset)) kept.motion = fx.motion;
  for (const phase of PHASES) {
    const chosen = fx[phase];
    if (chosen && isClipAnimation(chosen.id) && animationPhase(chosen.id) === phase) (kept as Record<string, unknown>)[phase] = chosen;
  }
  return kept;
}

export const fxIsEmpty = (fx: Omit<ClipMotionFx, 'base'>): boolean => !(fx.motion || fx.in || fx.out || fx.loop);

export function composeFx(base: ClipTransform, fx: Omit<ClipMotionFx, 'base'>, clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): ClipTransform {
  let transform = base;
  if (fx.motion && isMotionPreset(fx.motion.preset)) {
    const move = buildMotionTransform(fx.motion.preset, clip, project, motionBase(clip, project, assets), { amount: fx.motion.amount, focus: fx.motion.focus });
    transform = { ...transform, position: move.position, scale: move.scale };
  }
  for (const phase of PHASES) {
    const chosen = fx[phase];
    if (!chosen || !isClipAnimation(chosen.id)) continue;
    const id = chosen.id as ClipAnimationId;
    const window = animationWindow(id, clip, project.fps, phase === 'loop' ? undefined : 'seconds' in chosen ? chosen.seconds : undefined);
    const pose = evaluateTransform(transform, phase === 'in' ? window.to : window.from);
    transform = withAnimation(transform, id, window, { position: pose.position, scale: pose.scale, rotation: pose.rotation, opacity: pose.opacity }, project, project.fps);
  }
  return transform;
}
