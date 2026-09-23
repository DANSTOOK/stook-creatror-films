import type { Clip } from '@shared/types';

/**
 * Fades at the ends of a clip.
 *
 * The commonest thing anybody does to a cut, and until now it took a pair of
 * keyframes typed into the inspector. Resolve puts a small handle in each top
 * corner of the clip: drag it inwards and a shaded wedge shows how long the
 * fade is. That is what this is.
 *
 * One envelope serves both halves of the job. The compositor multiplies the
 * clip's opacity by it, and both audio paths multiply the gain by it, so a
 * fade on a clip with sound takes the picture and the sound down together -
 * which is what an editor means by "fade out".
 *
 * Linear, not eased. A linear fade on picture is what every editor does, and
 * for sound it is the shape that a dragged handle implies; an eased audio
 * fade is a different tool (the curve on a keyframe), not a better default.
 */

/** Frames of fade, kept inside the clip and never overlapping each other. */
export function fadeLengths(clip: Pick<Clip, 'durationFrames' | 'fadeInFrames' | 'fadeOutFrames'>): {
  fadeIn: number;
  fadeOut: number;
} {
  const duration = Math.max(0, clip.durationFrames);
  const wantedIn = Math.max(0, Math.round(clip.fadeInFrames ?? 0));
  const wantedOut = Math.max(0, Math.round(clip.fadeOutFrames ?? 0));

  // Two fades cannot use the same frames: when they would meet, each keeps
  // its share of what there is, in proportion to what it asked for.
  if (wantedIn + wantedOut <= duration) {
    return { fadeIn: Math.min(wantedIn, duration), fadeOut: Math.min(wantedOut, duration) };
  }

  const total = wantedIn + wantedOut;
  const fadeIn = Math.round((wantedIn / total) * duration);
  return { fadeIn, fadeOut: duration - fadeIn };
}

/**
 * How much of the clip comes through, at a frame counted from its start.
 *
 * 0 at the very first frame of a fade-in and 1 once it is over, which means a
 * one-frame fade is a one-frame ramp rather than a frame of black.
 */
export function fadeGainAt(
  clip: Pick<Clip, 'durationFrames' | 'fadeInFrames' | 'fadeOutFrames'>,
  frameFromStart: number,
): number {
  const { fadeIn, fadeOut } = fadeLengths(clip);
  if (fadeIn === 0 && fadeOut === 0) return 1;

  const duration = Math.max(1, clip.durationFrames);
  const at = Math.min(Math.max(frameFromStart, 0), duration);

  let gain = 1;
  if (fadeIn > 0 && at < fadeIn) gain = Math.min(gain, at / fadeIn);

  const fromEnd = duration - at;
  if (fadeOut > 0 && fromEnd < fadeOut) gain = Math.min(gain, Math.max(0, fromEnd) / fadeOut);

  return Math.min(1, Math.max(0, gain));
}

/** Whether anything is faded at all, for skipping the work when nothing is. */
export const hasFade = (clip: Pick<Clip, 'fadeInFrames' | 'fadeOutFrames'>): boolean =>
  (clip.fadeInFrames ?? 0) > 0 || (clip.fadeOutFrames ?? 0) > 0;

/**
 * The fade a handle drag asks for, in frames.
 *
 * `pointerFrame` is where the pointer is, in frames from the clip's start for
 * the head and from its end for the tail. Never longer than the clip, and
 * never negative - dragging back past the corner takes the fade off.
 */
export function fadeFromDrag(
  clip: Pick<Clip, 'durationFrames'>,
  edge: 'in' | 'out',
  framesFromEdge: number,
): number {
  void edge;
  return Math.min(Math.max(0, Math.round(framesFromEdge)), Math.max(0, clip.durationFrames));
}

/** A fade of at least this many frames gets a handle worth grabbing. */
export const MIN_VISIBLE_FADE = 1;
