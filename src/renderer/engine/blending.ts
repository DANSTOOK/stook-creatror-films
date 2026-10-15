import { BLEND_MODES, type BlendMode } from '@shared/types';

/**
 * How a layer mixes with what is already under it.
 *
 * The formulas are the ones in W3C Compositing and Blending Level 1 (the same
 * set Photoshop, Premiere and Resolve use), written here once in TypeScript
 * and once in GLSL (shaders/Blend.glsl). This copy is the reference: the tests
 * check it against the spec, and the GPU check renders the shader and compares
 * it against this, so the two cannot drift apart unnoticed.
 *
 * Everything here works on straight (un-premultiplied) colour in 0..1.
 */

/** The list lives with the type, so the project format and the engine cannot disagree. */
export { BLEND_MODES };

/** What the shader is told; must match the numbers in Blend.glsl. */
export const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
};

const multiply = (cb: number, cs: number): number => cb * cs;
const screen = (cb: number, cs: number): number => cb + cs - cb * cs;
const hardLight = (cb: number, cs: number): number => (cs <= 0.5 ? multiply(cb, 2 * cs) : screen(cb, 2 * cs - 1));

/** The spec's D(Cb), used by soft-light only. */
const softLightD = (cb: number): number => (cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb));

/** B(Cb, Cs) for one channel, straight from the spec. */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'multiply':
      return multiply(cb, cs);
    case 'screen':
      return screen(cb, cs);
    case 'overlay':
      return hardLight(cs, cb);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'color-dodge':
      if (cb === 0) return 0;
      if (cs === 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case 'color-burn':
      if (cb === 1) return 1;
      if (cs === 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case 'hard-light':
      return hardLight(cb, cs);
    case 'soft-light':
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softLightD(cb) - cb);
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    default:
      return cs;
  }
}

export interface Rgba {
  /** Straight (not premultiplied) colour, 0..1. */
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * One layer over another: blend, then composite source-over.
 *
 * Per the spec, the blended colour is mixed back towards the source where the
 * backdrop is transparent - Cr = (1 - ab) x Cs + ab x B(Cb, Cs) - and the
 * result is composited with co = as x Cs + ab x Cb x (1 - as).
 *
 * Returns straight colour, as it takes it.
 */
export function blendOver(backdrop: Rgba, source: Rgba, mode: BlendMode, opacity = 1): Rgba {
  const as = Math.min(1, Math.max(0, source.a * opacity));
  const ab = backdrop.a;
  const ao = as + ab * (1 - as);

  const channel = (cb: number, cs: number): number => {
    const blended = (1 - ab) * cs + ab * blendChannel(mode, cb, cs);
    const premultiplied = as * blended + ab * cb * (1 - as);
    return ao === 0 ? 0 : premultiplied / ao;
  };

  return {
    r: channel(backdrop.r, source.r),
    g: channel(backdrop.g, source.g),
    b: channel(backdrop.b, source.b),
    a: ao,
  };
}
