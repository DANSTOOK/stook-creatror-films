import type { Clip, Keyframe } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { evaluateNumber } from '@renderer/engine/KeyframeEvaluator';

/**
 * A clip's gain and stereo position over time.
 *
 * Playback and export are two different audio graphs (see mixRouting), so the
 * curve has to be described once, here, in a form both can schedule: a list of
 * points in clip frames, which each graph turns into ramps on its own
 * AudioParam. Nothing in here touches Web Audio or the store, so it is unit
 * tested without a browser.
 *
 * The keyframes are stored in TIMELINE frames, like the transform's, so they
 * travel with the clip when it is moved (timelineOps.shiftClipKeyframes). The
 * points come out in frames from the clip's start, because that is what the
 * fades and the scheduling work in.
 */

/** A point on the curve: how far into the clip, and the value there. */
export interface EnvelopePoint {
  /** Frames from the clip's start. */
  frame: number;
  value: number;
}

export const VOLUME_RANGE: readonly [number, number] = [0, 2];
export const PAN_RANGE: readonly [number, number] = [-1, 1];

/**
 * How finely a curved stretch is sampled.
 *
 * A linear segment needs only its two ends; anything eased has to be drawn as
 * short straight pieces, and this is how many. Sixteen is inaudible as steps
 * (a fade of a second becomes 16 ramps of 60 ms) and keeps the number of
 * scheduled events in the dozens rather than one per frame, which for a
 * ten-minute clip would be eighteen thousand of them.
 */
const CURVE_STEPS = 16;

const track = (keyframes: Keyframe<number>[] | undefined): Keyframe<number>[] =>
  keyframes && keyframes.length > 0 ? keyframes : [];

export const hasVolumeEnvelope = (clip: Pick<Clip, 'volumeKeyframes'>): boolean => track(clip.volumeKeyframes).length > 0;
export const hasPanEnvelope = (clip: Pick<Clip, 'panKeyframes'>): boolean => track(clip.panKeyframes).length > 0;

/**
 * The gain at a timeline frame: the curve when there is one, the fader when
 * there is not. The two are the same parameter, never multiplied.
 */
export function clipVolumeAt(clip: Pick<Clip, 'volume' | 'volumeKeyframes'>, frame: number): number {
  const keys = track(clip.volumeKeyframes);
  const value = keys.length > 0 ? evaluateNumber(keys, frame, clip.volume) : clip.volume;
  return clamp(value, VOLUME_RANGE[0], VOLUME_RANGE[1]);
}

/** The stereo position at a timeline frame, by the same rule. */
export function clipPanAt(clip: Pick<Clip, 'pan' | 'panKeyframes'>, frame: number): number {
  const keys = track(clip.panKeyframes);
  const raw = keys.length > 0 ? evaluateNumber(keys, frame, clip.pan) : clip.pan;
  return clamp(Number.isFinite(raw) ? raw : 0, PAN_RANGE[0], PAN_RANGE[1]);
}

/**
 * The curve as points in clip frames, ready to be scheduled.
 *
 * Returns null when there is nothing to animate, so the callers keep their
 * plain `param.value = x` path and no clip without an envelope pays for one.
 * Outside the keyframes the value is held, which is what every NLE draws and
 * what evaluateNumber already does.
 */
export function envelopePoints(
  keyframes: Keyframe<number>[] | undefined,
  clip: Pick<Clip, 'startFrame' | 'durationFrames'>,
  fallback: number,
  range: readonly [number, number],
): EnvelopePoint[] | null {
  const keys = [...track(keyframes)].sort((first, second) => first.frame - second.frame);
  if (keys.length === 0) return null;

  const last = clip.durationFrames;
  const at = (clipFrame: number): number =>
    clamp(evaluateNumber(keys, clip.startFrame + clipFrame, fallback), range[0], range[1]);

  const points: EnvelopePoint[] = [{ frame: 0, value: at(0) }];
  const push = (frame: number): void => {
    const bounded = clamp(frame, 0, last);
    const tail = points[points.length - 1];
    if (tail && Math.abs(tail.frame - bounded) < 1e-6) return;
    points.push({ frame: bounded, value: at(bounded) });
  };

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const from = key.frame - clip.startFrame;
    push(from);
    const next = keys[index + 1];
    if (!next) continue;
    const to = next.frame - clip.startFrame;
    if (to <= from) continue;
    // A hold does not move until the next keyframe, and then it jumps. Two
    // points a thousandth of a frame apart say exactly that; without the
    // first one the ramp between the ends would slide through the hold, which
    // is the opposite of what it means.
    if (key.easing === 'hold') {
      push(to - 1e-3);
      continue;
    }
    // A straight line needs no middle.
    if (key.easing === 'linear') continue;
    for (let step = 1; step < CURVE_STEPS; step += 1) push(from + ((to - from) * step) / CURVE_STEPS);
  }
  push(last);

  return points;
}

/** The curve of a clip's gain, or null when its gain does not move. */
export const volumePoints = (clip: Clip): EnvelopePoint[] | null =>
  envelopePoints(clip.volumeKeyframes, clip, clip.volume, VOLUME_RANGE);

/** The curve of a clip's stereo position, or null when it does not move. */
export const panPoints = (clip: Clip): EnvelopePoint[] | null =>
  envelopePoints(clip.panKeyframes, clip, clip.pan, PAN_RANGE);

/**
 * The value of a sampled curve at a clip frame.
 *
 * The points are already fine enough that straight interpolation between them
 * IS the curve, so this is a lookup rather than a second easing pass.
 */
export function envelopeValueAt(points: EnvelopePoint[], frame: number): number {
  if (points.length === 0) return 0;
  let index = 0;
  while (index < points.length - 1 && points[index + 1].frame <= frame) index += 1;
  const from = points[index];
  const next = points[index + 1];
  if (!next || next.frame <= from.frame) return from.value;
  const progress = (frame - from.frame) / (next.frame - from.frame);
  return from.value + (next.value - from.value) * progress;
}

/**
 * The same curve, with `frames` sure to be sampled on it.
 *
 * A fade bends the gain at places the curve knows nothing about - where the
 * fade-in ends, where the fade-out starts - and a ramp drawn straight past one
 * of those would cut the corner. Adding them as points keeps the two shapes
 * multiplying correctly.
 */
export function withBreakpoints(points: EnvelopePoint[], frames: readonly number[]): EnvelopePoint[] {
  const merged = [...points];
  for (const frame of frames) {
    if (!Number.isFinite(frame)) continue;
    if (merged.some((point) => Math.abs(point.frame - frame) < 1e-6)) continue;
    merged.push({ frame, value: envelopeValueAt(points, frame) });
  }
  return merged.sort((first, second) => first.frame - second.frame);
}

/** What an AudioParam needs to be, for scheduling, without dragging in the DOM types. */
export interface SchedulableParam {
  value: number;
  setValueAtTime(value: number, when: number): unknown;
  linearRampToValueAtTime(value: number, when: number): unknown;
}

/**
 * Write `points` onto `param` as ramps.
 *
 * `when` is the context time the clip starts sounding and `offsetSeconds` how
 * far into the clip that is - playback from the middle of a clip starts the
 * source part-way through, and the curve has to start from the matching place
 * rather than from the beginning. `scale` multiplies every value, which is how
 * the fades ride on top of the curve.
 */
export function scheduleEnvelope(
  param: SchedulableParam,
  points: EnvelopePoint[],
  when: number,
  offsetSeconds: number,
  framesPerSecond: number,
  scale: (clipFrame: number) => number = () => 1,
): void {
  if (points.length === 0) return;
  const fps = framesPerSecond > 0 ? framesPerSecond : 30;
  const started = Math.max(0, offsetSeconds) * fps;
  param.setValueAtTime(envelopeValueAt(points, started) * scale(started), when);
  for (const point of points) {
    if (point.frame <= started) continue;
    param.linearRampToValueAtTime(point.value * scale(point.frame), when + (point.frame - started) / fps);
  }
}

/**
 * The animated part of a clip's sound, as a comparable string.
 *
 * A curve already written into the audio graph cannot be bent in place: the
 * ramps are scheduled ahead of the playhead. So the engine keeps the signature
 * of what it scheduled, and when an edit changes it the schedule is rebuilt -
 * the same treatment a track changing bus gets. Moving the fader on a clip
 * with no curve stays a live parameter change, which is the common case.
 */
export function envelopeSignature(clip: Pick<Clip, 'volumeKeyframes' | 'panKeyframes'>): string {
  const of = (keys: Keyframe<number>[] | undefined): string =>
    track(keys)
      .map((key) => `${key.frame}:${key.value}:${key.easing}`)
      .join(',');
  return `${of(clip.volumeKeyframes)}|${of(clip.panKeyframes)}`;
}

/**
 * What the fader should change, given where the playhead is.
 *
 * With no curve it is the plain setting, as it always was. With one, the
 * number under the fader is the curve's value at the playhead, so dragging it
 * moves the whole curve by the difference - the fader keeps meaning "louder"
 * or "quieter" instead of going dead the moment a keyframe exists. Every
 * keyframe is held inside the parameter's range, so a curve pushed against
 * the top does not flatten: the drag simply stops.
 */
export function faderPatch(clip: Clip, which: 'volume' | 'pan', wanted: number, frame: number): Partial<Clip> {
  const range = which === 'volume' ? VOLUME_RANGE : PAN_RANGE;
  const field = which === 'volume' ? 'volumeKeyframes' : 'panKeyframes';
  const keys = track(clip[field]);
  const asked = clamp(wanted, range[0], range[1]);
  if (keys.length === 0) return { [which]: asked };

  const now = which === 'volume' ? clipVolumeAt(clip, frame) : clipPanAt(clip, frame);
  let delta = asked - now;
  // Held so that no keyframe is pushed past either end of the range.
  for (const key of keys) {
    delta = Math.max(range[0] - key.value, Math.min(range[1] - key.value, delta));
  }
  if (delta === 0) return {};
  return { [field]: keys.map((key) => ({ ...key, value: clamp(key.value + delta, range[0], range[1]) })) };
}
