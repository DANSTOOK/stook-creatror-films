import { describe, expect, it } from 'vitest';
import { backOut, bounceOut, cubicBezierEase, curveOf, easeProgress, elasticOut, EASING_CURVES } from '@renderer/keyframes/easing';

/**
 * The shapes of a move between keyframes (renderer/keyframes/easing): the
 * beziers against the values a browser gives for the same CSS curves, the
 * hold, and Penner's back, elastic and bounce.
 */

const samples = (fn: (t: number) => number) => Array.from({ length: 101 }, (_, i) => fn(i / 100));

describe('beziers', () => {
  it('match the CSS curves: ease-in, ease-out and ease-in-out at the middle', () => {
    // What getComputedStyle-driven animations give at 50% for cubic-bezier(.42,0,1,1) and its mirrors.
    expect(cubicBezierEase(0.5, EASING_CURVES.easeIn!)).toBeCloseTo(0.3153, 3);
    expect(cubicBezierEase(0.5, EASING_CURVES.easeOut!)).toBeCloseTo(0.6847, 3);
    expect(cubicBezierEase(0.5, EASING_CURVES.easeInOut!)).toBeCloseTo(0.5, 6);
  });

  it('a handle above the box overshoots; the ends stay put; a straight curve is linear', () => {
    const overshoot = { cp1: { x: 0.34, y: 1.56 }, cp2: { x: 0.64, y: 1 } };
    expect(Math.max(...samples((t) => cubicBezierEase(t, overshoot))) > 1.05).toBe(true);
    expect(cubicBezierEase(0, overshoot)).toBe(0);
    expect(cubicBezierEase(1, overshoot)).toBe(1);
    expect(cubicBezierEase(0.3, { cp1: { x: 0.2, y: 0.2 }, cp2: { x: 0.8, y: 0.8 } })).toBeCloseTo(0.3, 9);
  });

  it('time handles past the ends are held to them, as CSS does', () => {
    const wild = { cp1: { x: -1, y: 0 }, cp2: { x: 2, y: 1 } };
    const values = samples((t) => cubicBezierEase(t, wild));
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values[0]).toBe(0);
    expect(values[100]).toBe(1);
  });
});

describe('the other shapes', () => {
  it('a hold keeps the value until the next keyframe, then jumps', () => {
    expect(easeProgress(0, 'hold')).toBe(0);
    expect(easeProgress(0.999, 'hold')).toBe(0);
    expect(easeProgress(1, 'hold')).toBe(1);
  });

  it('back overshoots about 10 % and settles; elastic springs past and settles; bounce never passes the end', () => {
    const back = samples(backOut);
    expect(Math.max(...back)).toBeGreaterThan(1.09);
    expect(Math.max(...back)).toBeLessThan(1.11);
    expect(back[100]).toBeCloseTo(1, 9);
    const elastic = samples(elasticOut);
    expect(Math.max(...elastic)).toBeGreaterThan(1.2);
    expect(elastic[0]).toBe(0);
    expect(elastic[100]).toBe(1);
    const bounce = samples(bounceOut);
    expect(Math.max(...bounce)).toBeLessThanOrEqual(1);
    expect(bounce[100]).toBeCloseTo(1, 9);
    // It comes back down between the bounces.
    expect(bounce.some((value, i) => i > 0 && value < bounce[i - 1])).toBe(true);
  });

  it('every shape starts at 0 and ends at 1', () => {
    for (const easing of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'back', 'elastic', 'bounce'] as const) {
      expect(easeProgress(0, easing)).toBeCloseTo(0, 9);
      expect(easeProgress(1, easing)).toBeCloseTo(1, 9);
    }
    expect(easeProgress(0.5, 'bezier', { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } })).toBeCloseTo(0.5, 6);
  });
});

describe('curveOf', () => {
  it('handles for the beziers and linear, none for a hold or a spring', () => {
    expect(curveOf('easeInOut')).toEqual(EASING_CURVES.easeInOut);
    expect(curveOf('linear')?.cp1.x).toBeCloseTo(1 / 3, 9);
    const custom = { cp1: { x: 0.1, y: 0.9 }, cp2: { x: 0.2, y: 1 } };
    expect(curveOf('bezier', custom)).toBe(custom);
    expect(curveOf('hold')).toBeNull();
    expect(curveOf('bounce')).toBeNull();
  });
});
