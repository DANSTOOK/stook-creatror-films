import type { Clip } from '@shared/types';
import { fadeGainAt, fadeLengths } from '@renderer/timing/clipFades';
import { crossfadeIn, crossfadeOut } from '@renderer/timing/transitions';

/**
 * A clip's fades, written onto its gain.
 *
 * Shared by the two audio paths on purpose: playback and the export mix have
 * to agree about what a fade sounds like, and the only way to be sure of that
 * is for them to run the same code. The shape comes from `clipFades`, which is
 * also what the compositor multiplies the picture by.
 */

/** The part of an AudioParam a fade needs; both contexts satisfy it. */
export type GainParam = Pick<AudioParam, 'value' | 'setValueAtTime' | 'linearRampToValueAtTime' | 'setValueCurveAtTime'>;

/** Points written per second of a crossfade curve: smooth to the ear, cheap to schedule. */
const CURVE_POINTS_PER_SECOND = 200;

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
  if ((clip.crossfadeInFrames ?? 0) > 0 || (clip.crossfadeOutFrames ?? 0) > 0) {
    applyCrossfadeEnvelope(gain, clip, base, when, offsetSeconds, framesPerSecond);
    return;
  }
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

/**
 * A clip at a transition's cut: equal-power curves (sin in, cos out) where
 * it crossfades, and its ordinary linear fade at an end that does not. Each
 * curve is written from wherever playback joins the clip, so a play started
 * half-way through a crossfade starts at the right level.
 */
function applyCrossfadeEnvelope(
  gain: GainParam,
  clip: Clip,
  base: number,
  when: number,
  offsetSeconds: number,
  framesPerSecond: number,
): void {
  const fps = framesPerSecond > 0 ? framesPerSecond : 30;
  const duration = Math.max(1, clip.durationFrames);
  const started = Math.max(0, offsetSeconds) * fps;
  const secondsTo = (frame: number): number => when + Math.max(0, (frame - started) / fps);
  const { fadeIn, fadeOut } = fadeLengths(clip);
  const inFrames = Math.min(duration, clip.crossfadeInFrames ?? 0);
  const outFrames = Math.min(duration - inFrames, clip.crossfadeOutFrames ?? 0);
  const inShape = (frame: number): number =>
    inFrames > 0 ? crossfadeIn(frame / inFrames) : fadeIn > 0 ? Math.min(1, frame / fadeIn) : 1;
  const outShape = (frame: number): number => {
    const fromEnd = duration - frame;
    return outFrames > 0 ? crossfadeOut(1 - fromEnd / outFrames) : fadeOut > 0 ? Math.min(1, Math.max(0, fromEnd) / fadeOut) : 1;
  };
  const level = (frame: number): number => base * inShape(frame) * outShape(frame);
  const inEnd = inFrames > 0 ? inFrames : fadeIn;
  const outStart = duration - (outFrames > 0 ? outFrames : fadeOut);

  /** One curve from `from` to `to` (frames), sampled finely enough to be smooth. */
  const curve = (from: number, to: number, startAt: number): void => {
    const seconds = (to - from) / fps;
    if (seconds <= 0) return;
    const points = Math.max(2, Math.ceil(seconds * CURVE_POINTS_PER_SECOND));
    const values = new Float32Array(points);
    for (let i = 0; i < points; i += 1) values[i] = level(from + ((to - from) * i) / (points - 1));
    gain.setValueCurveAtTime(values, startAt, seconds);
  };

  // The way in, then flat, then the way out: never two curves at one moment.
  if (started < inEnd) curve(started, inEnd, when);
  else gain.setValueAtTime(level(started), when);
  const outFrom = Math.max(started, inEnd, outStart);
  if (outFrom < duration) {
    // A hair after the way in, which the curves may not share an instant with.
    const at = secondsTo(outFrom) + (started < inEnd && outFrom === inEnd ? 1e-4 : 0);
    curve(outFrom, duration, at);
  }
}
