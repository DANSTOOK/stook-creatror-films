import type { CurvePoint, GradeCurves } from '@shared/types';

/**
 * The curves: Resolve's Custom curves (Y, R, G, B) and Lumetri's RGB curves,
 * then the four "versus" curves of Resolve's Curves palette.
 *
 *   master, red, green, blue   input level -> output level, 0..1. Neutral is
 *                              the diagonal, stored as its two ends.
 *   hueVsHue                   hue -> hue shift, in turns (-0.5..0.5)
 *   hueVsSat                   hue -> saturation change (-1..1: x0 .. x2)
 *   hueVsLuma                  hue -> brightness change (-0.5..0.5)
 *   lumaVsSat                  luma -> saturation change (-1..1)
 *
 * The last four are offsets: 0 everywhere is neutral, and an empty list is
 * that. The level curves are interpolated with a monotone cubic
 * (Fritsch-Carlson), which never overshoots its points - a curve pulled up
 * between two points does not dip below either - so there are no surprise
 * reversals. The hue curves wrap around, red to red, with a periodic
 * Catmull-Rom spline; luma vs saturation uses the monotone cubic as well.
 *
 * On the GPU each curve is a row of CURVE_SIZE samples in one small float
 * texture (bakeCurves), read with linear interpolation between samples.
 * `applyCurves` is the same arithmetic in JavaScript: the reference the GPU
 * is tested against.
 */

export type LevelCurve = 'master' | 'red' | 'green' | 'blue';
export type OffsetCurve = 'hueVsHue' | 'hueVsSat' | 'hueVsLuma' | 'lumaVsSat';
export type CurveId = LevelCurve | OffsetCurve;

export const LEVEL_CURVES: readonly LevelCurve[] = ['master', 'red', 'green', 'blue'];
export const OFFSET_CURVES: readonly OffsetCurve[] = ['hueVsHue', 'hueVsSat', 'hueVsLuma', 'lumaVsSat'];
/** Rows of the curve texture, in this order. */
export const CURVE_ROWS: readonly CurveId[] = [...LEVEL_CURVES, ...OFFSET_CURVES];
export const CURVE_SIZE = 1024;

/** How far each offset curve reaches, up and down. */
export const OFFSET_RANGE: Record<OffsetCurve, number> = { hueVsHue: 0.5, hueVsSat: 1, hueVsLuma: 0.5, lumaVsSat: 1 };

/** The hue curves wrap around; luma vs saturation does not. */
export const isPeriodic = (curve: CurveId): boolean => curve === 'hueVsHue' || curve === 'hueVsSat' || curve === 'hueVsLuma';

/**
 * Below this chroma (max - min of R, G, B) the hue curves fade out, fully
 * gone at grey: a colour with almost no colour has an unstable hue, and a
 * hue curve would otherwise tint near-greys at random.
 */
export const HUE_FADE_CHROMA = 0.1;

export const neutralCurve = (curve: CurveId): CurvePoint[] =>
  (LEVEL_CURVES as readonly string[]).includes(curve) ? [{ x: 0, y: 0 }, { x: 1, y: 1 }] : [];

export const neutralCurves = (): GradeCurves => ({
  master: neutralCurve('master'),
  red: neutralCurve('red'),
  green: neutralCurve('green'),
  blue: neutralCurve('blue'),
  hueVsHue: [],
  hueVsSat: [],
  hueVsLuma: [],
  lumaVsSat: [],
});

/** True when a curve changes nothing: on the diagonal, or flat at zero. */
export function isNeutralCurve(curve: CurveId, points: readonly CurvePoint[]): boolean {
  if ((LEVEL_CURVES as readonly string[]).includes(curve)) {
    return points.length === 0 || points.every((point) => point.y === point.x);
  }
  return points.every((point) => point.y === 0);
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Points as saved by any build: clamped, sorted, no two at the same place. */
export function normalizeCurve(curve: CurveId, points: unknown): CurvePoint[] {
  if (!Array.isArray(points)) return neutralCurve(curve);
  const level = (LEVEL_CURVES as readonly string[]).includes(curve);
  const range = level ? 1 : OFFSET_RANGE[curve as OffsetCurve];
  const cleaned = points
    .map((point) => ({
      x: clamp(finite((point as CurvePoint)?.x, 0), 0, level ? 1 : 0.9999),
      y: clamp(finite((point as CurvePoint)?.y, 0), level ? 0 : -range, range),
    }))
    .sort((a, b) => a.x - b.x)
    .filter((point, index, all) => index === 0 || point.x > all[index - 1].x);
  if (level && cleaned.length < 2) return neutralCurve(curve);
  return cleaned;
}

export function normalizeCurves(curves: Partial<GradeCurves> | undefined): GradeCurves {
  const source = curves ?? {};
  return Object.fromEntries(CURVE_ROWS.map((curve) => [curve, normalizeCurve(curve, source[curve])])) as unknown as GradeCurves;
}

/* Interpolation ----------------------------------------------------------- */

/**
 * Fritsch-Carlson monotone cubic through `points` (sorted by x). Flat beyond
 * the first and last point. Never overshoots: between two points the curve
 * stays between their values.
 */
export function monotoneCubic(points: readonly CurvePoint[]): (x: number) => number {
  const n = points.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => points[0].y;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i += 1) secants.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const tangents: number[] = new Array(n);
  tangents[0] = secants[0];
  tangents[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    tangents[i] = secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2;
  }
  // Fritsch-Carlson: limit the tangents so each segment stays monotone.
  for (let i = 0; i < n - 1; i += 1) {
    if (secants[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / secants[i];
    const b = tangents[i + 1] / secants[i];
    const length = a * a + b * b;
    if (length > 9) {
      const tau = 3 / Math.sqrt(length);
      tangents[i] = tau * a * secants[i];
      tangents[i + 1] = tau * b * secants[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i += 1;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * tangents[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * tangents[i + 1];
  };
}

/** Periodic Catmull-Rom through `points` (x in 0..1, sorted), wrapping at 1. */
export function periodicSpline(points: readonly CurvePoint[]): (x: number) => number {
  const n = points.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => points[0].y;
  // The point before the first and after the last, a turn away.
  const at = (index: number): CurvePoint => {
    const wrapped = ((index % n) + n) % n;
    const turns = Math.floor(index / n);
    return { x: points[wrapped].x + turns, y: points[wrapped].y };
  };
  return (value: number) => {
    let x = value - Math.floor(value);
    if (x < points[0].x) x += 1;
    let i = 0;
    while (i < n - 1 && x >= points[i + 1].x) i += 1;
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const h = p2.x - p1.x;
    const t = h > 0 ? (x - p1.x) / h : 0;
    const m1 = ((p2.y - p0.y) / Math.max(1e-9, p2.x - p0.x)) * h;
    const m2 = ((p3.y - p1.y) / Math.max(1e-9, p3.x - p1.x)) * h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * m2;
  };
}

export function curveFunction(curve: CurveId, points: readonly CurvePoint[]): (x: number) => number {
  if (isNeutralCurve(curve, points)) return (LEVEL_CURVES as readonly string[]).includes(curve) ? (x) => x : () => 0;
  return isPeriodic(curve) ? periodicSpline(points) : monotoneCubic(points);
}

/* Baking for the GPU ------------------------------------------------------ */

export interface BakedCurves {
  /** CURVE_ROWS.length rows of CURVE_SIZE samples, row after row. */
  data: Float32Array;
  levelsActive: boolean;
  versusActive: boolean;
  /** Identifies the curves, to reuse a texture already uploaded. */
  key: string;
}

/**
 * Sample every curve. Level curves at x = i / (SIZE - 1), both ends
 * included; hue curves at x = i / SIZE, a whole turn with the wrap left to
 * the reader. Luma vs saturation like the levels.
 */
export function bakeCurves(curves: GradeCurves): BakedCurves {
  const data = new Float32Array(CURVE_ROWS.length * CURVE_SIZE);
  CURVE_ROWS.forEach((curve, row) => {
    const sample = curveFunction(curve, curves[curve]);
    const periodic = isPeriodic(curve);
    for (let i = 0; i < CURVE_SIZE; i += 1) {
      const x = periodic ? i / CURVE_SIZE : i / (CURVE_SIZE - 1);
      data[row * CURVE_SIZE + i] = sample(x);
    }
  });
  return {
    data,
    levelsActive: LEVEL_CURVES.some((curve) => !isNeutralCurve(curve, curves[curve])),
    versusActive: OFFSET_CURVES.some((curve) => !isNeutralCurve(curve, curves[curve])),
    key: JSON.stringify(curves),
  };
}

/* The reference ----------------------------------------------------------- */

/** One baked curve read as the shader reads it: linear between samples. */
export function readBaked(baked: BakedCurves, curve: CurveId, x: number): number {
  const row = CURVE_ROWS.indexOf(curve) * CURVE_SIZE;
  if (isPeriodic(curve)) {
    const position = (x - Math.floor(x)) * CURVE_SIZE;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = baked.data[row + (index % CURVE_SIZE)];
    const b = baked.data[row + ((index + 1) % CURVE_SIZE)];
    return a + (b - a) * fraction;
  }
  const position = clamp(x, 0, 1) * (CURVE_SIZE - 1);
  const index = Math.min(CURVE_SIZE - 2, Math.floor(position));
  const fraction = position - index;
  const a = baked.data[row + index];
  const b = baked.data[row + index + 1];
  return a + (b - a) * fraction;
}

type Rgb = [number, number, number];
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

export function rgbToHsv([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 1e-10) {
    if (max === r) hue = ((g - b) / delta) / 6;
    else if (max === g) hue = ((b - r) / delta + 2) / 6;
    else hue = ((r - g) / delta + 4) / 6;
  }
  hue -= Math.floor(hue);
  return [hue, max > 1e-10 ? delta / max : 0, max];
}

export function hsvToRgb([h, s, v]: Rgb): Rgb {
  const channel = (n: number): number => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [channel(5), channel(3), channel(1)];
}

/**
 * The curves on one pixel, as ColorGrading.glsl applies them: the level
 * curves (master on every channel, then each channel its own), then the
 * hue curves faded out toward grey, then luma vs saturation.
 */
export function applyCurves(rgb: Rgb, baked: BakedCurves): Rgb {
  let color: Rgb = [...rgb];
  // A level curve covers 0..1; past either end the picture carries on at the
  // curve's end value plus the distance, so values beyond white survive.
  const level = (curve: CurveId, value: number): number => readBaked(baked, curve, value) + (value - clamp(value, 0, 1));
  if (baked.levelsActive) {
    color = color.map((value) => level('master', value)) as Rgb;
    color = [level('red', color[0]), level('green', color[1]), level('blue', color[2])];
  }
  if (baked.versusActive) {
    color = color.map((value) => Math.max(0, value)) as Rgb;
    const hsv = rgbToHsv(color);
    const chroma = Math.max(...color) - Math.min(...color);
    const fade = Math.min(1, chroma / HUE_FADE_CHROMA);
    const hue = hsv[0];
    const shift = readBaked(baked, 'hueVsHue', hue) * fade;
    if (shift !== 0) color = hsvToRgb([hsv[0] + shift - Math.floor(hsv[0] + shift), hsv[1], hsv[2]]);
    const satFactor = 1 + readBaked(baked, 'hueVsSat', hue) * fade;
    let y = KR * color[0] + KG * color[1] + KB * color[2];
    color = color.map((value) => y + (value - y) * satFactor) as Rgb;
    const lift = readBaked(baked, 'hueVsLuma', hue) * fade;
    color = color.map((value) => value + lift) as Rgb;
    y = KR * color[0] + KG * color[1] + KB * color[2];
    const lumaFactor = 1 + readBaked(baked, 'lumaVsSat', y);
    color = color.map((value) => y + (value - y) * lumaFactor) as Rgb;
  }
  return color;
}
