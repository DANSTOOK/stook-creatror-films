import type { ColorGradingConfig, VignetteConfig } from '@shared/types';
import { applyCurves, bakeCurves, normalizeCurves } from './curves';

/**
 * The primary correction, as arithmetic.
 *
 * The four wheels are Resolve's primaries - Lift, Gamma, Gain and Offset - and
 * Final Cut's Shadows, Midtones, Highlights and Global. They are carried to
 * the GPU as one ASC CDL (American Society of Cinematographers Color Decision
 * List): per channel,
 *
 *     out = (in * slope + offset) ^ power
 *
 * which is exactly what lift/gamma/gain are once written out:
 *
 *     gain * in + lift * (1 - in)  =  in * (gain - lift) + lift
 *
 * so slope = gain - lift, offset = lift + the Offset wheel, power = the gamma.
 * Lift raises black and leaves white where it is, gain scales white and
 * leaves black, gamma bends the middle with both ends fixed, and offset moves
 * everything. CDL is the interchange every grading tool reads, so a grade made
 * here can be written out as a .cdl later.
 *
 * Each wheel is stored as R, G, B, 0 each when neutral, -1..1:
 *
 *   lift    adds   0.5 * value    to black         (so +-0.5 at the ends)
 *   gain    scales by 1 + value                    (0x .. 2x)
 *   gamma   raises to the power 2 ^ -value         (2 .. 0.5: + is brighter)
 *   offset  adds   0.5 * value    to everything
 *
 * A wheel's puck and its brightness slider are two views of the same three
 * numbers: the slider is their BT.709 luma, the puck their colour difference
 * (Cb, Cr) - the same plane the vectorscope draws - so pushing a wheel toward
 * red moves the picture toward the vectorscope's red target.
 *
 * Everything here is mirrored by ColorGrading.glsl; `gradePixel` is the
 * reference the GPU is tested against.
 */

export type Rgb = [number, number, number];
export type WheelId = 'lift' | 'gamma' | 'gain' | 'offset';
export const WHEELS: readonly WheelId[] = ['lift', 'gamma', 'gain', 'offset'];

/** Each channel of a wheel stays within +-WHEEL_RANGE. */
export const WHEEL_RANGE = 1;
/** The colour difference (Cb or Cr) at the rim of a wheel. */
export const RIM_CHROMA = 0.5;
export const DEFAULT_PIVOT = 0.5;

const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

const clampRange = (value: number): number => Math.min(WHEEL_RANGE, Math.max(-WHEEL_RANGE, value));
const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const neutralWheel = (): Rgb => [0, 0, 0];

/** The brightness part of a wheel: its BT.709 luma. */
export const wheelMaster = (value: Rgb): number => KR * value[0] + KG * value[1] + KB * value[2];

/** The colour part of a wheel, as Cb and Cr. */
export function wheelChroma(value: Rgb): { cb: number; cr: number } {
  const y = wheelMaster(value);
  return { cb: (value[2] - y) / 1.8556, cr: (value[0] - y) / 1.5748 };
}

/** The wheel whose luma is `master` and whose colour difference is `cb`, `cr`. */
export function wheelFrom(master: number, cb: number, cr: number): Rgb {
  const r = master + 1.5748 * cr;
  const b = master + 1.8556 * cb;
  const g = (master - KR * r - KB * b) / KG;
  return [clampRange(r), clampRange(g), clampRange(b)];
}

/** Where a wheel's puck sits, -1..1 across (Cb) and up (Cr); 1 is the rim. */
export function puckOf(value: Rgb): { x: number; y: number } {
  const { cb, cr } = wheelChroma(value);
  return { x: cb / RIM_CHROMA, y: cr / RIM_CHROMA };
}

/** The wheel with its puck at `x`, `y` (clamped to the rim) and its master kept. */
export function withPuck(value: Rgb, x: number, y: number): Rgb {
  const length = Math.hypot(x, y);
  const scale = length > 1 ? 1 / length : 1;
  return wheelFrom(wheelMaster(value), x * scale * RIM_CHROMA, y * scale * RIM_CHROMA);
}

/** The wheel with its brightness set to `master` and its colour kept. */
export function withMaster(value: Rgb, master: number): Rgb {
  const shift = master - wheelMaster(value);
  return [clampRange(value[0] + shift), clampRange(value[1] + shift), clampRange(value[2] + shift)];
}

export const isNeutralWheel = (value: Rgb): boolean => value[0] === 0 && value[1] === 0 && value[2] === 0;

export interface Cdl {
  slope: Rgb;
  offset: Rgb;
  power: Rgb;
  /** False when every wheel is neutral: the GPU then skips the CDL altogether. */
  active: boolean;
}

/** The four wheels as one ASC CDL. */
export function cdlOf(grading: Pick<ColorGradingConfig, 'lift' | 'gamma' | 'gain' | 'offset'>): Cdl {
  const lift = grading.lift ?? neutralWheel();
  const gamma = grading.gamma ?? neutralWheel();
  const gain = grading.gain ?? neutralWheel();
  const offset = grading.offset ?? neutralWheel();
  const channel = (index: number): [number, number, number] => {
    const liftAdd = 0.5 * lift[index];
    const gainMul = 1 + gain[index];
    return [gainMul - liftAdd, liftAdd + 0.5 * offset[index], 2 ** -gamma[index]];
  };
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  return {
    slope: [r[0], g[0], b[0]],
    offset: [r[1], g[1], b[1]],
    power: [r[2], g[2], b[2]],
    active: ![lift, gamma, gain, offset].every(isNeutralWheel),
  };
}

/** A grade as saved by any build: fields a build before the wheels had no word for come back neutral. */
export function normalizeGrading(grading: Partial<ColorGradingConfig> | undefined): ColorGradingConfig {
  const wheel = (value: unknown): Rgb =>
    Array.isArray(value) && value.length === 3
      ? [clampRange(finite(value[0], 0)), clampRange(finite(value[1], 0)), clampRange(finite(value[2], 0))]
      : neutralWheel();
  const source = grading ?? {};
  return {
    ...source,
    enabled: source.enabled === true,
    exposure: finite(source.exposure, 0),
    contrast: finite(source.contrast, 1),
    saturation: finite(source.saturation, 1),
    temperature: finite(source.temperature, 0),
    tint: finite(source.tint, 0),
    lutIntensity: finite(source.lutIntensity, 1),
    pivot: finite(source.pivot, DEFAULT_PIVOT),
    lift: wheel(source.lift),
    gamma: wheel(source.gamma),
    gain: wheel(source.gain),
    offset: wheel(source.offset),
    curves: normalizeCurves(source.curves),
    vignette: normalizeVignette(source.vignette),
  };
}

/* The vignette ------------------------------------------------------------ */

export const neutralVignette = (): VignetteConfig => ({ amount: 0, size: 0.5, roundness: 0, feather: 0.5 });

export function normalizeVignette(vignette: Partial<VignetteConfig> | undefined): VignetteConfig {
  const source = vignette ?? {};
  const clampTo = (value: unknown, low: number, high: number, fallback: number): number =>
    Math.min(high, Math.max(low, finite(value, fallback)));
  return {
    amount: clampTo(source.amount, -1, 1, 0),
    size: clampTo(source.size, 0, 1, 0.5),
    roundness: clampTo(source.roundness, -1, 1, 0),
    feather: clampTo(source.feather, 0, 1, 0.5),
  };
}

/**
 * How much of the vignette reaches a point of the frame, 0..1: `u`, `v`
 * 0..1 across and down, `aspect` the frame's width over its height.
 *
 * Distance is measured from the centre in half-frames, on a superellipse:
 * roundness 0 follows the frame's own shape, +1 bends it to a circle (the
 * horizontal squeezed to the vertical's scale), -1 squares it off. The
 * darkening starts at 1.4 x size and ramps over 1.2 x feather.
 */
export function vignetteWeight(u: number, v: number, aspect: number, vignette: VignetteConfig): number {
  const px = (u - 0.5) * 2;
  const py = (v - 0.5) * 2;
  const qx = px * (1 + (aspect - 1) * Math.max(vignette.roundness, 0));
  const exponent = 2 + 6 * Math.max(-vignette.roundness, 0);
  const distance = (Math.abs(qx) ** exponent + Math.abs(py) ** exponent) ** (1 / exponent);
  const start = vignette.size * 1.4;
  const end = start + Math.max(vignette.feather, 0.01) * 1.2;
  const t = Math.min(1, Math.max(0, (distance - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/* The reference: one pixel through the whole primary grade --------------- */

const srgbToLinear = (c: number): number => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));

/**
 * What the grading shader makes of one pixel (no LUT), 0..1 per channel.
 * Step for step the same as ColorGrading.glsl.
 */
export function gradePixel(
  rgb: Rgb,
  grading: ColorGradingConfig,
  /** Where the pixel is, for the vignette; the centre when left out. */
  at: { u: number; v: number; aspect: number } = { u: 0.5, v: 0.5, aspect: 16 / 9 },
): Rgb {
  const exposure = 2 ** grading.exposure;
  const t = grading.temperature;
  const tint = grading.tint;
  const balance: Rgb = [1 + 0.3 * t + 0.05 * tint, 1 - 0.1 * tint, 1 - 0.3 * t + 0.05 * tint];

  let color = rgb.map((value, index) => {
    const linear = srgbToLinear(clamp01(value)) * exposure * balance[index];
    return linearToSrgb(Math.max(linear, 0));
  }) as Rgb;

  const cdl = cdlOf(grading);
  if (cdl.active) {
    color = color.map((value, index) => {
      const graded = value * cdl.slope[index] + cdl.offset[index];
      return graded > 0 ? graded ** cdl.power[index] : graded;
    }) as Rgb;
  }

  color = color.map((value) => (value - grading.pivot) * grading.contrast + grading.pivot) as Rgb;
  const luma = KR * clamp01(color[0]) + KG * clamp01(color[1]) + KB * clamp01(color[2]);
  color = color.map((value) => luma + (value - luma) * grading.saturation) as Rgb;
  // The curves: levels, then the versus curves. After saturation, before the LUT.
  if (grading.curves) {
    const baked = bakeCurves(grading.curves);
    if (baked.levelsActive || baked.versusActive) color = applyCurves(color, baked);
  }

  // (The reference leaves the LUT out.) Then the vignette, then the clamp.
  const vignette = grading.vignette;
  if (vignette && vignette.amount !== 0) {
    const weight = vignetteWeight(at.u, at.v, at.aspect, vignette) * Math.abs(vignette.amount);
    color = color.map((value) => (vignette.amount < 0 ? value * (1 - weight) : value + (1 - value) * weight)) as Rgb;
  }
  return color.map(clamp01) as Rgb;
}
