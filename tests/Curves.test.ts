import { describe, expect, it } from 'vitest';
import type { ColorGradingConfig, GradeCurves } from '@shared/types';
import {
  applyCurves,
  bakeCurves,
  hsvToRgb,
  isNeutralCurve,
  monotoneCubic,
  neutralCurves,
  normalizeCurves,
  periodicSpline,
  rgbToHsv,
} from '@renderer/color/curves';
import { gradePixel, normalizeGrading, vignetteWeight } from '@renderer/color/grade';

const withCurves = (patch: Partial<GradeCurves>): GradeCurves => ({ ...neutralCurves(), ...patch });

describe('level curves: monotone cubic', () => {
  it('passes through its points', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.6 }, { x: 1, y: 1 }];
    const curve = monotoneCubic(points);
    for (const point of points) expect(curve(point.x)).toBeCloseTo(point.y, 12);
  });

  it('never overshoots between points', () => {
    // A steep step: an ordinary cubic spline rings above 0.9 and below 0.1 here.
    const points = [{ x: 0, y: 0 }, { x: 0.45, y: 0.1 }, { x: 0.55, y: 0.9 }, { x: 1, y: 1 }];
    const curve = monotoneCubic(points);
    for (let i = 0; i < points.length - 1; i += 1) {
      const low = Math.min(points[i].y, points[i + 1].y);
      const high = Math.max(points[i].y, points[i + 1].y);
      for (let t = 0; t <= 1; t += 0.01) {
        const y = curve(points[i].x + t * (points[i + 1].x - points[i].x));
        expect(y).toBeGreaterThanOrEqual(low - 1e-12);
        expect(y).toBeLessThanOrEqual(high + 1e-12);
      }
    }
  });

  it('stays monotone where the points are', () => {
    const curve = monotoneCubic([{ x: 0, y: 0 }, { x: 0.2, y: 0.6 }, { x: 0.25, y: 0.62 }, { x: 1, y: 1 }]);
    let previous = -1;
    for (let x = 0; x <= 1; x += 0.001) {
      const y = curve(x);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = y;
    }
  });

  it('an inverted curve gives the negative', () => {
    const baked = bakeCurves(withCurves({ master: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }));
    for (const value of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      applyCurves([value, value, value], baked).forEach((out) => expect(out).toBeCloseTo(1 - value, 6));
    }
  });

  it('red alone touches only red', () => {
    const baked = bakeCurves(withCurves({ red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }] }));
    const [r, g, b] = applyCurves([0.5, 0.5, 0.5], baked);
    expect(r).toBeCloseTo(0.7, 3);
    expect(g).toBe(0.5);
    expect(b).toBe(0.5);
  });

  it('carries values past white on beyond the curve', () => {
    const baked = bakeCurves(withCurves({ master: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }] }));
    expect(applyCurves([1.2, 1.2, 1.2], baked)[0]).toBeCloseTo(1.1, 6);
  });
});

describe('hue curves', () => {
  it('HSV there and back', () => {
    for (const rgb of [[1, 0, 0], [0.2, 0.7, 0.4], [0.9, 0.9, 0.1]] as Array<[number, number, number]>) {
      hsvToRgb(rgbToHsv(rgb)).forEach((value, index) => expect(value).toBeCloseTo(rgb[index], 12));
    }
  });

  it('wrap around: the curve at hue 0 meets the curve at hue 1', () => {
    const curve = periodicSpline([{ x: 0.1, y: 0.2 }, { x: 0.5, y: -0.1 }, { x: 0.8, y: 0.05 }]);
    expect(curve(0)).toBeCloseTo(curve(1), 12);
    expect(curve(0.999999)).toBeCloseTo(curve(0), 4);
  });

  it('rotating red by 120 degrees in Hue vs Hue gives green', () => {
    // A third of a turn at red, and neutral well away from it.
    const baked = bakeCurves(withCurves({ hueVsHue: [{ x: 0, y: 1 / 3 }, { x: 0.3, y: 0 }, { x: 0.7, y: 0 }] }));
    const [r, g, b] = applyCurves([1, 0, 0], baked);
    expect(r).toBeLessThan(0.02);
    expect(g).toBeGreaterThan(0.98);
    expect(b).toBeLessThan(0.02);
  });

  it('Hue vs Sat at blue desaturates blue and leaves yellow', () => {
    const baked = bakeCurves(withCurves({ hueVsSat: [{ x: 1 / 6, y: 0 }, { x: 2 / 3, y: -1 }, { x: 0.9, y: 0 }] }));
    const blue = applyCurves([0.1, 0.1, 0.9], baked);
    expect(Math.max(...blue) - Math.min(...blue)).toBeLessThan(0.02);
    const yellow = applyCurves([0.9, 0.9, 0.1], baked);
    yellow.forEach((value, index) => expect(value).toBeCloseTo([0.9, 0.9, 0.1][index], 4));
  });

  it('fades out at grey: a near-grey keeps its colour', () => {
    const baked = bakeCurves(withCurves({ hueVsHue: [{ x: 0, y: 0.5 }] }));
    const grey = applyCurves([0.5, 0.5, 0.5], baked);
    grey.forEach((value) => expect(value).toBeCloseTo(0.5, 12));
  });
});

describe('neutral curves and old projects', () => {
  it('the neutral curves are neutral and switch themselves off', () => {
    const baked = bakeCurves(neutralCurves());
    expect(baked.levelsActive).toBe(false);
    expect(baked.versusActive).toBe(false);
    expect(isNeutralCurve('master', [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])).toBe(true);
  });

  it('a grade from before the curves opens with them neutral and no vignette', () => {
    const grading = normalizeGrading({ enabled: true, exposure: 0.2 } as Partial<ColorGradingConfig>);
    expect(grading.curves).toEqual(neutralCurves());
    expect(grading.vignette.amount).toBe(0);
  });

  it('cleans up points: sorted, in range, no two at the same x', () => {
    const curves = normalizeCurves({ master: [{ x: 1, y: 1 }, { x: 0.5, y: 2 }, { x: 0, y: 0 }, { x: 0.5, y: 0.3 }] });
    expect(curves.master).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 1 }]);
  });
});

describe('the vignette', () => {
  const vignette = { amount: -1, size: 0.5, roundness: 0, feather: 0.5 };
  it('leaves the centre alone and darkens the corners', () => {
    expect(vignetteWeight(0.5, 0.5, 16 / 9, vignette)).toBe(0);
    expect(vignetteWeight(0, 0, 16 / 9, vignette)).toBeGreaterThan(0.5);
    const grading = normalizeGrading({ enabled: true, vignette });
    expect(gradePixel([0.5, 0.5, 0.5], grading, { u: 0.5, v: 0.5, aspect: 16 / 9 })[0]).toBeCloseTo(0.5, 6);
    expect(gradePixel([0.5, 0.5, 0.5], grading, { u: 0, v: 0, aspect: 16 / 9 })[0]).toBeLessThan(0.25);
  });

  it('round is round: at +1 equal distances across and down weigh the same', () => {
    const round = { ...vignette, roundness: 1 };
    const aspect = 2;
    // Half a frame height down equals a quarter of the width across.
    expect(vignetteWeight(0.5 + 0.25 * 0.5, 0.5, aspect, round)).toBeCloseTo(vignetteWeight(0.5, 0.5 + 0.5 * 0.5, aspect, round), 9);
  });
});
