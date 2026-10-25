import type { BezierCurve, Easing } from '@shared/types';

export type { Easing };

/**
 * The shapes a move between two keyframes can take, for the keyframe editor
 * and the engine alike (engine/KeyframeEvaluator applies them, so the viewer
 * and every export move the same way).
 *
 * The model is Theatre.js's (theatre-js/theatre, @theatre/core, Apache-2.0):
 * each stretch between two keyframes is a cubic bezier on time - a CSS
 * cubic-bezier, from (0, 0) to (1, 1), its two handles the outgoing
 * keyframe's right handle and the next keyframe's left one - or a hold, which
 * keeps the value until the next keyframe and then jumps. Here the stretch's
 * curve sits on the keyframe it leaves (`easing` and `bezierParams`), the
 * convention every editor's timeline uses and this app's projects already
 * keep. A handle may go above 1 or below 0, for an overshoot.
 *
 * The springy shapes - back, elastic, bounce - are Robert Penner's easing
 * equations (BSD licence), which no single bezier can draw.
 */

/** The presets as beziers: the CSS ones, and the "back" overshoot as CSS easings libraries draw it. */
export const EASING_CURVES: Readonly<Partial<Record<Easing, BezierCurve>>> = {
  easeIn: { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } },
  easeOut: { cp1: { x: 0, y: 0 }, cp2: { x: 0.58, y: 1 } },
  easeInOut: { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } },
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
 * The curve's parameter at time `x`. Newton-Raphson converges in a handful of
 * steps for a well-formed curve (UnitBezier's way, which Theatre.js uses
 * too); bisection keeps a degenerate one (handles bunched at an end) stable.
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

/** Linear progress `t` (0-1) through a cubic bezier. Time handles are held to 0-1, as CSS holds them. */
export function cubicBezierEase(t: number, curve: BezierCurve): number {
  const progress = Math.min(1, Math.max(0, t));
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const x1 = Math.min(1, Math.max(0, curve.cp1.x));
  const x2 = Math.min(1, Math.max(0, curve.cp2.x));
  // Handles on the diagonal: a straight line.
  if (x1 === curve.cp1.y && x2 === curve.cp2.y) return progress;
  return bezierAxis(solveBezierT(progress, x1, x2), curve.cp1.y, curve.cp2.y);
}

/* Robert Penner's equations (BSD), the "out" forms: the move settles at the end. */

/** Overshoots a little past the end, then comes back. */
export function backOut(t: number): number {
  const s = 1.70158;
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}

/** Springs past the end and back, a few times, smaller each time. */
export function elasticOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const period = 0.3;
  return 2 ** (-10 * t) * Math.sin(((t - period / 4) * (2 * Math.PI)) / period) + 1;
}

/** Drops onto the end and bounces, as a ball does. */
export function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) {
    const u = t - 1.5 / d;
    return n * u * u + 0.75;
  }
  if (t < 2.5 / d) {
    const u = t - 2.25 / d;
    return n * u * u + 0.9375;
  }
  const u = t - 2.625 / d;
  return n * u * u + 0.984375;
}

/**
 * How far along the move is (0 the keyframe it leaves, 1 the next) at linear
 * progress `t` through the stretch, for the stretch's `easing`. Can go past
 * 0 or 1 - an overshoot - for back, elastic and a bezier with handles out of
 * the box.
 */
export function easeProgress(t: number, easing: Easing, bezierParams?: BezierCurve): number {
  const progress = Math.min(1, Math.max(0, t));
  switch (easing) {
    case 'linear':
      return progress;
    case 'hold':
      // The value is kept to the next keyframe, then jumps to it.
      return progress >= 1 ? 1 : 0;
    case 'back':
      return backOut(progress);
    case 'elastic':
      return elasticOut(progress);
    case 'bounce':
      return bounceOut(progress);
    case 'bezier':
      return bezierParams ? cubicBezierEase(progress, bezierParams) : progress;
    default: {
      const curve = EASING_CURVES[easing];
      return curve ? cubicBezierEase(progress, curve) : progress;
    }
  }
}

/**
 * The bezier that draws `easing`, for the curve editor's handles: the stretch's
 * own for a custom one, the preset's, a straight line for linear - and null
 * for a hold or a springy shape, which have no handles to drag.
 */
export function curveOf(easing: Easing, bezierParams?: BezierCurve): BezierCurve | null {
  if (easing === 'bezier') return bezierParams ?? { cp1: { x: 1 / 3, y: 1 / 3 }, cp2: { x: 2 / 3, y: 2 / 3 } };
  if (easing === 'linear') return { cp1: { x: 1 / 3, y: 1 / 3 }, cp2: { x: 2 / 3, y: 2 / 3 } };
  return EASING_CURVES[easing] ?? null;
}

/** Every shape a stored keyframe may name; anything else a project holds is read as linear. */
export const EASING_IDS: readonly Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'back', 'elastic', 'bounce', 'bezier'];

export const isEasing = (value: unknown): value is Easing => EASING_IDS.includes(value as Easing);
