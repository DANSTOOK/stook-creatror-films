import type { Clip, SpeedRampPreset } from '@shared/types';

/**
 * Clip speed: how a frame on the timeline picks a frame of footage.
 *
 * Taken from how the others behave, and deliberately no cleverer:
 *
 * - Premiere's Speed/Duration ties speed and duration together - the chain
 *   button is what separates them - so doubling the speed halves the clip and
 *   leaves the footage it shows unchanged. Its Rate Stretch tool is the same
 *   sum from the other end: drag the edge, and the speed follows.
 * - Frames are **sampled**, never invented: at 50% each frame of footage is
 *   held for two frames of timeline, at 200% every other one is skipped. That
 *   is Premiere's default (Frame Sampling); blending and optical flow are
 *   different features, not a better version of this one.
 * - Reverse plays the same footage backwards, as Premiere's Reverse Speed
 *   does.
 *
 * The range is 10% to 1000%. Filmora allows 0.01x, and at that setting six
 * seconds of footage becomes ten minutes of one held frame - a thing worth
 * having only once everything else about retiming is solid.
 */

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

export const clampSpeed = (speed: number): number =>
  Number.isFinite(speed) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) : 1;

/** A clip's speed, for clips saved before speed existed. */
export const speedOf = (clip: Pick<Clip, 'speed'>): number => clampSpeed(clip.speed ?? 1);

export const isReversed = (clip: Pick<Clip, 'reversed'>): boolean => clip.reversed === true;

/**
 * How many frames of footage a clip consumes.
 *
 * This is the quantity that stays put when the speed changes: the clip goes on
 * showing the same piece of film, taking more or less time over it.
 */
export function sourceFramesUsed(clip: Pick<Clip, 'durationFrames' | 'speed'>): number {
  return Math.max(1, Math.round(clip.durationFrames * speedOf(clip)));
}

/** The timeline length that footage takes at a given speed. */
export function durationForSpeed(sourceFrames: number, speed: number): number {
  return Math.max(1, Math.round(sourceFrames / clampSpeed(speed)));
}

/** The speed that makes that footage fill exactly this many frames - Rate Stretch. */
export function speedForDuration(sourceFrames: number, durationFrames: number): number {
  if (durationFrames <= 0) return MAX_SPEED;
  return clampSpeed(sourceFrames / durationFrames);
}

/**
 * Speed ramps - CapCut's "Curve" speeds, Premiere's time remapping made
 * simple: a shape of relative speeds along the clip (nine points, joined by
 * straight lines). The clip's average speed is still `speed`, so it shows
 * the same footage in the same length; the ramp only moves which frame is
 * shown when, faster here and slower there.
 */
export const SPEED_RAMPS: Record<SpeedRampPreset, readonly number[]> = {
  // Fast and slow, twice over.
  montage: [2.5, 2.5, 0.6, 0.6, 2.5, 2.5, 0.6, 0.6, 1],
  // In at speed, slow motion through the middle, out at speed.
  hero: [1.6, 1.6, 1.6, 0.3, 0.3, 0.3, 1.6, 1.6, 1.6],
  // A burst, then a long slow moment, then a burst.
  bullet: [2.2, 2.2, 0.2, 0.2, 0.2, 0.2, 0.2, 2.2, 2.2],
  // Steady, a sudden leap, steady.
  jump: [1, 1, 1, 4, 4, 1, 1, 1, 1],
  // Rushing in, settling.
  flashIn: [4, 3, 2, 1.4, 1, 1, 1, 1, 1],
  // Settled, rushing out.
  flashOut: [1, 1, 1, 1, 1, 1.4, 2, 3, 4],
  // Block 8. Dropping in at speed and staying in slow motion from there.
  dropIn: [3.5, 3, 2, 0.5, 0.35, 0.35, 0.35, 0.35, 0.35],
  // One moment almost stopped - the hit, the catch, the look - and nothing else touched.
  impact: [1.5, 1.5, 1.5, 1.5, 0.15, 1.5, 1.5, 1.5, 1.5],
  // Slow, a whip through the middle, slow again: the turn of a head, a pan.
  whip: [0.5, 0.5, 0.6, 5, 5, 0.6, 0.5, 0.5, 0.5],
  // Breathing: never jarring, never still. For a shot that only needs life.
  breathe: [1, 0.7, 0.5, 0.7, 1, 1.4, 1.8, 1.4, 1],
  // Stuttering: fast and slow against each other, on the beat.
  stutter: [2.5, 0.4, 2.5, 0.4, 2.5, 0.4, 2.5, 0.4, 1],
  // A run-up: slow to begin, faster all the way out.
  runUp: [0.4, 0.5, 0.7, 1, 1.4, 2, 2.8, 3.6, 4.5],
};

export const isSpeedRamp = (value: unknown): value is SpeedRampPreset => typeof value === 'string' && value in SPEED_RAMPS;

/** Relative speed of a ramp at `u` (0..1 along the clip). */
export function rampSpeedAt(preset: SpeedRampPreset, u: number): number {
  const points = SPEED_RAMPS[preset];
  const at = Math.min(1, Math.max(0, u)) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(at));
  return points[i] + (points[i + 1] - points[i]) * (at - i);
}

/** How much of the footage a ramp has shown by `u` along the clip, 0..1: the integral of its speed, made whole. */
export function rampedFraction(preset: SpeedRampPreset, u: number): number {
  const points = SPEED_RAMPS[preset];
  const segments = points.length - 1;
  const area = (to: number): number => {
    const at = Math.min(1, Math.max(0, to)) * segments;
    let sum = 0;
    for (let i = 0; i < segments && i < at; i += 1) {
      const part = Math.min(1, at - i);
      const end = points[i] + (points[i + 1] - points[i]) * part;
      sum += ((points[i] + end) / 2) * part;
    }
    return sum;
  };
  const total = area(1);
  return total > 0 ? area(u) / total : u;
}

/**
 * The frame of footage shown at a timeline frame.
 *
 * `frame` is absolute on the timeline. Rounding is what "frame sampling"
 * means: the nearest frame of footage, held or skipped as the speed requires.
 */
export function sourceFrameFor(
  clip: Pick<Clip, 'startFrame' | 'durationFrames' | 'sourceOffsetFrames' | 'speed' | 'reversed' | 'speedRamp'>,
  frame: number,
): number {
  const elapsed = frame - clip.startFrame;
  const speed = speedOf(clip);
  const used = sourceFramesUsed(clip);
  // Along a ramp, the footage shown so far is the curve's integral; one speed, a straight line.
  const shown = clip.speedRamp && isSpeedRamp(clip.speedRamp)
    ? Math.min(used - 1, Math.round(used * rampedFraction(clip.speedRamp, elapsed / Math.max(1, clip.durationFrames))))
    : Math.round(elapsed * speed);

  if (!isReversed(clip)) {
    return clip.sourceOffsetFrames + shown;
  }

  // Backwards from the last frame the clip covers, so the first frame on the
  // timeline is the last frame of the footage - what "play it backwards" has
  // to mean for it to be reversible.
  return clip.sourceOffsetFrames + Math.max(0, used - 1 - shown);
}

/**
 * The longest this clip can be at this speed, given the footage behind it.
 *
 * A still has no end, so it reports none and may be held for as long as
 * anyone likes.
 */
export function maxDurationAtSpeed(
  clip: Pick<Clip, 'sourceOffsetFrames'>,
  speed: number,
  sourceFrames: number | undefined,
): number | undefined {
  if (sourceFrames === undefined) return undefined;
  const available = Math.max(1, sourceFrames - clip.sourceOffsetFrames);
  return Math.max(1, Math.floor(available / clampSpeed(speed)));
}

export interface SpeedChange {
  speed: number;
  reversed: boolean;
}

/**
 * What a clip becomes at a new speed.
 *
 * The footage it shows is kept; the length follows. Limited by what is left in
 * the file, so slowing a clip down cannot run it past its own end.
 */
export function retimed<T extends Clip>(
  clip: T,
  change: SpeedChange,
  sourceFrames: number | undefined,
): T {
  const speed = clampSpeed(change.speed);
  const used = sourceFramesUsed(clip);
  const wanted = durationForSpeed(used, speed);
  const ceiling = maxDurationAtSpeed(clip, speed, sourceFrames);

  return {
    ...clip,
    speed,
    reversed: change.reversed,
    durationFrames: ceiling === undefined ? wanted : Math.min(wanted, ceiling),
  };
}

/** "200%", "50%" - and reversed speeds carry the arrow the timeline draws. */
export function speedLabel(clip: Pick<Clip, 'speed' | 'reversed'>): string | null {
  const speed = speedOf(clip);
  const reversed = isReversed(clip);
  if (speed === 1 && !reversed) return null;

  const percent = speed >= 1 ? Math.round(speed * 100) : Math.round(speed * 1000) / 10;
  return `${reversed ? '◀ ' : ''}${percent}%`;
}

/**
 * Whether sound can follow the picture.
 *
 * At another speed it can: played faster or slower, which shifts the pitch -
 * what Premiere does with "Maintain Audio Pitch" off. Backwards it cannot,
 * not yet: that needs the samples themselves reversed, and a buffer read
 * back-to-front is not something a playback rate can express.
 */
export function audioFollowsSpeed(clip: Pick<Clip, 'speed' | 'reversed' | 'speedRamp'>): boolean {
  // Nor along a ramp: one playback rate cannot follow a speed that changes.
  return !isReversed(clip) && !clip.speedRamp;
}
