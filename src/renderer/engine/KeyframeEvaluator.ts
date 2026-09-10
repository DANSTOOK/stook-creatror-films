import type {
  BezierCurve,
  ClipTransform,
  Easing,
  Keyframe,
  KeyframeValue,
  ResolvedTransform,
  Vector2D,
} from '@shared/types';
import { clamp01, isVector2D, lerp, lerpVec2 } from '@shared/utils/math';

/**
 * Keyframe interpolation.
 *
 * Easing is a property of the *outgoing* keyframe, matching the convention used
 * by every NLE: the curve authored on keyframe N shapes the segment N -> N+1.
 */

/** Presets expressed as CSS-style cubic-beziers with P0 = (0,0), P3 = (1,1). */
const EASING_PRESETS: Record<Exclude<Easing, 'bezier'>, BezierCurve | null> = {
  linear: null,
  easeIn: { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } },
  easeOut: { cp1: { x: 0, y: 0 }, cp2: { x: 0.58, y: 1 } },
};

const bezierAxis = (t: number, p1: number, p2: number): number => {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
};

const bezierAxisDerivative = (t: number, p1: number, p2: number): number => {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
};

/**
 * Invert the parametric x curve so the caller can sample y at a given progress.
 * Newton-Raphson converges in a handful of steps for well-formed curves; the
 * bisection fallback keeps degenerate curves (flat or non-monotonic x) stable.
 */
function solveBezierT(x: number, x1: number, x2: number): number {
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const error = bezierAxis(t, x1, x2) - x;
    if (Math.abs(error) < 1e-7) return t;
    const slope = bezierAxisDerivative(t, x1, x2);
    if (Math.abs(slope) < 1e-7) break;
    t -= error / slope;
  }

  let low = 0;
  let high = 1;
  t = x;
  for (let i = 0; i < 40; i += 1) {
    const value = bezierAxis(t, x1, x2);
    if (Math.abs(value - x) < 1e-7) return t;
    if (value < x) low = t;
    else high = t;
    t = (low + high) * 0.5;
  }
  return t;
}

/** Map linear progress `t` through a cubic bezier easing curve. */
export function cubicBezierEase(t: number, curve: BezierCurve): number {
  const progress = clamp01(t);
  // A curve whose control points sit on the diagonal is the identity.
  if (
    curve.cp1.x === curve.cp1.y &&
    curve.cp2.x === curve.cp2.y &&
    curve.cp1.x === 0 &&
    curve.cp2.x === 1
  ) {
    return progress;
  }
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;

  const solvedT = solveBezierT(progress, curve.cp1.x, curve.cp2.x);
  return bezierAxis(solvedT, curve.cp1.y, curve.cp2.y);
}

/** Apply the easing declared on a keyframe to normalized segment progress. */
export function applyEasing(
  t: number,
  easing: Easing,
  bezierParams?: BezierCurve,
): number {
  const progress = clamp01(t);
  if (easing === 'bezier') {
    return bezierParams ? cubicBezierEase(progress, bezierParams) : progress;
  }
  const preset = EASING_PRESETS[easing];
  return preset ? cubicBezierEase(progress, preset) : progress;
}

const isSorted = <T extends KeyframeValue>(keyframes: Keyframe<T>[]): boolean => {
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i].frame < keyframes[i - 1].frame) return false;
  }
  return true;
};

/** Ascending-by-frame copy. The store keeps tracks sorted; this is a guard. */
export function sortKeyframes<T extends KeyframeValue>(
  keyframes: Keyframe<T>[],
): Keyframe<T>[] {
  return isSorted(keyframes) ? keyframes : [...keyframes].sort((a, b) => a.frame - b.frame);
}

/** Index of the last keyframe at or before `frame`, or -1 when none exists. */
function findLowerIndex<T extends KeyframeValue>(
  keyframes: Keyframe<T>[],
  frame: number,
): number {
  let low = 0;
  let high = keyframes.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keyframes[mid].frame <= frame) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function blend<T extends KeyframeValue>(a: T, b: T, t: number): T {
  if (isVector2D(a) && isVector2D(b)) return lerpVec2(a, b, t) as T;
  return lerp(a as number, b as number, t) as T;
}

/**
 * Sample an animated property at `frame`.
 *
 * Outside the keyframe range the value is held (no extrapolation), which is
 * what an editor timeline shows before the first and after the last key.
 */
export function evaluateKeyframes<T extends KeyframeValue>(
  keyframes: Keyframe<T>[],
  frame: number,
  fallback: T,
): T {
  if (keyframes.length === 0) return fallback;

  const track = sortKeyframes(keyframes);
  if (track.length === 1) return track[0].value;

  const lowerIndex = findLowerIndex(track, frame);
  if (lowerIndex < 0) return track[0].value;
  if (lowerIndex >= track.length - 1) return track[track.length - 1].value;

  const from = track[lowerIndex];
  const to = track[lowerIndex + 1];
  const span = to.frame - from.frame;
  if (span <= 0) return to.value;

  const eased = applyEasing((frame - from.frame) / span, from.easing, from.bezierParams);
  return blend(from.value, to.value, eased);
}

export const evaluateNumber = (
  keyframes: Keyframe<number>[],
  frame: number,
  fallback: number,
): number => evaluateKeyframes(keyframes, frame, fallback);

export const evaluateVector = (
  keyframes: Keyframe<Vector2D>[],
  frame: number,
  fallback: Vector2D,
): Vector2D => evaluateKeyframes(keyframes, frame, fallback);

/** Collapse an animated transform into the flat values a draw call needs. */
export function evaluateTransform(
  transform: ClipTransform,
  frame: number,
): ResolvedTransform {
  return {
    position: evaluateVector(transform.position, frame, { x: 0, y: 0 }),
    scale: evaluateVector(transform.scale, frame, { x: 1, y: 1 }),
    rotation: evaluateNumber(transform.rotation, frame, 0),
    opacity: clamp01(evaluateNumber(transform.opacity, frame, 1)),
    anchorPoint: transform.anchorPoint,
  };
}
