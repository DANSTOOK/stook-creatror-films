import type { Clip } from '@shared/types';
import { fadeGainAt, fadeLengths } from '@renderer/timing/clipFades';

/**
 * A clip's fades, written onto its gain.
 *
 * Shared by the two audio paths on purpose: playback and the export mix have
 * to agree about what a fade sounds like, and the only way to be sure of that
 * is for them to run the same code. The shape comes from `clipFades`, which is
 * also what the compositor multiplies the picture by.
 */

/** The part of an AudioParam a fade needs; both contexts satisfy it. */
export type GainParam = Pick<AudioParam, 'value' | 'setValueAtTime' | 'linearRampToValueAtTime'>;

/**
 * @param when      Context time at which this clip starts sounding.
 * @param offsetSeconds How far into the clip that already is - playback can
 *                  join a clip in the middle, and so can an export range.
 * @param framesPerSecond Frames of the clip per second of sound. A retimed
 *                  clip spends its fade faster, so this is fps / speed.
 */
export function applyFadeEnvelope(
  gain: GainParam,
  clip: Clip,
  base: number,
  when: number,
  offsetSeconds: number,
  framesPerSecond: number,
): void {
  const { fadeIn, fadeOut } = fadeLengths(clip);
  if (fadeIn === 0 && fadeOut === 0) {
    gain.value = base;
    return;
  }

  const fps = framesPerSecond > 0 ? framesPerSecond : 30;
  const started = Math.max(0, offsetSeconds) * fps;
  const secondsTo = (frameFromStart: number): number =>
    when + Math.max(0, (frameFromStart - started) / fps);

  // Two linear ramps, which is exactly what the envelope describes: up to
  // full by the end of the fade-in, down to nothing at the last frame.
  gain.setValueAtTime(base * fadeGainAt(clip, started), when);
  if (fadeIn > 0 && started < fadeIn) {
    gain.linearRampToValueAtTime(base, secondsTo(fadeIn));
  }

  if (fadeOut > 0) {
    const fadeOutStarts = Math.max(started, clip.durationFrames - fadeOut);
    gain.setValueAtTime(base * fadeGainAt(clip, fadeOutStarts), secondsTo(fadeOutStarts));
    gain.linearRampToValueAtTime(0, secondsTo(clip.durationFrames));
  }
}
