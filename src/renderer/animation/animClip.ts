import type { Clip, DrawnAnimation } from '@shared/types';
import { createClip } from '@renderer/store/types';
import { createId } from '@shared/utils/id';
import { emptyAnimation } from './model';

/**
 * Making an animation clip.
 *
 * It is a clip like any other - it sits on a picture track, is trimmed,
 * moved, scaled and graded like a title - and like a title it has no file:
 * `sourceUri` is a name no decoder will ever be asked for, and the picture is
 * drawn from `anim` (engine/AnimationLayers).
 */

export const ANIM_URI_PREFIX = 'scf-anim://';

/** Seconds a new animation covers: two at a normal rate, which is 24 drawings on twos. */
export const ANIM_SECONDS = 2;

export function createAnimationClip(
  trackId: string,
  startFrame: number,
  durationFrames: number,
  name: string,
  anim: DrawnAnimation = emptyAnimation(),
): Clip {
  const clip = createClip({
    trackId,
    name,
    sourceUri: `${ANIM_URI_PREFIX}${createId()}`,
    startFrame,
    durationFrames,
    // The paper is transparent: what is drawn sits over the picture below,
    // which is what makes an animation usable over footage at all.
    hasAlphaChannel: true,
  });
  return { ...clip, anim };
}

export const isAnimationClip = (clip: Clip | undefined | null): boolean => Boolean(clip?.anim);
