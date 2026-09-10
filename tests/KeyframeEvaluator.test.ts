import { describe, expect, it } from 'vitest';
import type { Keyframe, Vector2D } from '@shared/types';
import {
  applyEasing,
  cubicBezierEase,
  evaluateKeyframes,
  evaluateTransform,
  sortKeyframes,
} from '@renderer/engine/KeyframeEvaluator';

const numberKey = (
  frame: number,
  value: number,
  easing: Keyframe<number>['easing'] = 'linear',
): Keyframe<number> => ({ id: `kf-${frame}`, frame, value, easing });

const vectorKey = (frame: number, value: Vector2D): Keyframe<Vector2D> => ({
  id: `kf-${frame}`,
  frame,
  value,
  easing: 'linear',
});

describe('cubicBezierEase', () => {
  it('pins the curve endpoints', () => {
    const curve = { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } };
    expect(cubicBezierEase(0, curve)).toBe(0);
    expect(cubicBezierEase(1, curve)).toBe(1);
  });

  it('reproduces the linear curve when control points sit on the diagonal', () => {
    const linear = { cp1: { x: 0.25, y: 0.25 }, cp2: { x: 0.75, y: 0.75 } };
    for (const t of [0.1, 0.33, 0.5, 0.87]) {
      expect(cubicBezierEase(t, linear)).toBeCloseTo(t, 5);
    }
  });

  it('lags behind linear for an ease-in curve', () => {
    // ease-in starts slow, so the eased value trails t through the first half.
    expect(applyEasing(0.25, 'easeIn')).toBeLessThan(0.25);
    expect(applyEasing(0.5, 'easeIn')).toBeLessThan(0.5);
  });

  it('runs ahead of linear for an ease-out curve', () => {
    expect(applyEasing(0.25, 'easeOut')).toBeGreaterThan(0.25);
    expect(applyEasing(0.5, 'easeOut')).toBeGreaterThan(0.5);
  });

  it('is monotonic across the unit interval', () => {
    const curve = { cp1: { x: 0.6, y: 0.02 }, cp2: { x: 0.2, y: 0.98 } };
    let previous = -1;
    for (let i = 0; i <= 40; i += 1) {
      const value = cubicBezierEase(i / 40, curve);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('clamps progress outside the unit interval', () => {
    expect(applyEasing(-3, 'easeIn')).toBe(0);
    expect(applyEasing(9, 'easeOut')).toBe(1);
  });

  it('falls back to linear when bezier easing has no control points', () => {
    expect(applyEasing(0.4, 'bezier')).toBeCloseTo(0.4, 6);
  });
});

describe('evaluateKeyframes', () => {
  it('returns the fallback for an empty track', () => {
    expect(evaluateKeyframes([], 12, 0.75)).toBe(0.75);
  });

  it('holds a single keyframe at every frame', () => {
    const track = [numberKey(30, 4)];
    expect(evaluateKeyframes(track, 0, 0)).toBe(4);
    expect(evaluateKeyframes(track, 30, 0)).toBe(4);
    expect(evaluateKeyframes(track, 300, 0)).toBe(4);
  });

  it('holds the first and last values instead of extrapolating', () => {
    const track = [numberKey(10, 1), numberKey(20, 3)];
    expect(evaluateKeyframes(track, 0, 0)).toBe(1);
    expect(evaluateKeyframes(track, 9, 0)).toBe(1);
    expect(evaluateKeyframes(track, 20, 0)).toBe(3);
    expect(evaluateKeyframes(track, 999, 0)).toBe(3);
  });

  it('interpolates numbers linearly between keyframes', () => {
    const track = [numberKey(0, 0), numberKey(10, 100)];
    expect(evaluateKeyframes(track, 0, 0)).toBe(0);
    expect(evaluateKeyframes(track, 5, 0)).toBeCloseTo(50, 6);
    expect(evaluateKeyframes(track, 7, 0)).toBeCloseTo(70, 6);
  });

  it('interpolates vectors component-wise', () => {
    const track = [vectorKey(0, { x: 0, y: 10 }), vectorKey(4, { x: 8, y: -10 })];
    expect(evaluateKeyframes(track, 2, { x: 0, y: 0 })).toEqual({ x: 4, y: 0 });
  });

  it('applies the easing of the outgoing keyframe to its own segment', () => {
    const track = [numberKey(0, 0, 'easeIn'), numberKey(10, 10, 'linear')];
    const eased = evaluateKeyframes(track, 5, 0);
    // easeIn is below the linear midpoint of 5.
    expect(eased).toBeLessThan(5);
    expect(eased).toBeGreaterThan(0);
  });

  it('uses custom bezier parameters when easing is "bezier"', () => {
    const track: Keyframe<number>[] = [
      {
        id: 'a',
        frame: 0,
        value: 0,
        easing: 'bezier',
        bezierParams: { cp1: { x: 0, y: 0.9 }, cp2: { x: 0.1, y: 1 } },
      },
      numberKey(10, 100),
    ];
    // A curve that shoots up immediately puts the midpoint well above 50.
    expect(evaluateKeyframes(track, 5, 0)).toBeGreaterThan(80);
  });

  it('handles unsorted tracks without mutating the input', () => {
    const track = [numberKey(20, 2), numberKey(0, 0), numberKey(10, 1)];
    const snapshot = track.map((keyframe) => keyframe.frame);

    expect(evaluateKeyframes(track, 5, 0)).toBeCloseTo(0.5, 6);
    expect(track.map((keyframe) => keyframe.frame)).toEqual(snapshot);
  });

  it('leaves an already sorted track untouched by sortKeyframes', () => {
    const track = [numberKey(0, 0), numberKey(5, 1)];
    expect(sortKeyframes(track)).toBe(track);
  });

  it('takes the later value when two keyframes share a frame', () => {
    const track = [numberKey(4, 1), numberKey(4, 9)];
    expect(evaluateKeyframes(track, 4, 0)).toBe(9);
  });
});

describe('evaluateTransform', () => {
  it('falls back to identity values when no property is animated', () => {
    const resolved = evaluateTransform(
      {
        position: [],
        scale: [],
        rotation: [],
        opacity: [],
        anchorPoint: { x: 0.5, y: 0.5 },
      },
      42,
    );

    expect(resolved).toEqual({
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
      anchorPoint: { x: 0.5, y: 0.5 },
    });
  });

  it('clamps opacity into 0..1 even when keyframed out of range', () => {
    const resolved = evaluateTransform(
      {
        position: [],
        scale: [],
        rotation: [],
        opacity: [numberKey(0, 4)],
        anchorPoint: { x: 0, y: 0 },
      },
      0,
    );

    expect(resolved.opacity).toBe(1);
  });

  it('samples every animated property at the requested frame', () => {
    const resolved = evaluateTransform(
      {
        position: [vectorKey(0, { x: 0, y: 0 }), vectorKey(10, { x: 100, y: 50 })],
        scale: [vectorKey(0, { x: 1, y: 1 }), vectorKey(10, { x: 2, y: 2 })],
        rotation: [numberKey(0, 0), numberKey(10, 90)],
        opacity: [numberKey(0, 0), numberKey(10, 1)],
        anchorPoint: { x: 0.5, y: 0.5 },
      },
      5,
    );

    expect(resolved.position).toEqual({ x: 50, y: 25 });
    expect(resolved.scale).toEqual({ x: 1.5, y: 1.5 });
    expect(resolved.rotation).toBeCloseTo(45, 6);
    expect(resolved.opacity).toBeCloseTo(0.5, 6);
  });
});
