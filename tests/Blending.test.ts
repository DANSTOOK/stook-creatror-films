import { describe, expect, it } from 'vitest';
import { BLEND_MODES, BLEND_MODE_INDEX, blendChannel, blendOver } from '@renderer/engine/blending';
import { createClip, createEmptyProject, normalizeProject } from '@renderer/store/types';
import type { BlendMode } from '@shared/types';

/**
 * Layers over layers: the blend modes, checked against the formulas in W3C
 * Compositing and Blending Level 1 rather than against what looks right.
 *
 * This file pins the reference implementation; the GPU check renders the
 * shader and compares it against this one, so a difference between the two
 * shows up as a failure rather than as a slightly wrong picture.
 */

const opaque = (value: number) => ({ r: value, g: value, b: value, a: 1 });

describe('the formulas, channel by channel', () => {
  it('multiply darkens by the product', () => {
    expect(blendChannel('multiply', 0.5, 0.5)).toBeCloseTo(0.25, 10);
    expect(blendChannel('multiply', 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(blendChannel('multiply', 0, 0.9)).toBe(0);
  });

  it('screen is multiply on the inverses', () => {
    expect(blendChannel('screen', 0.5, 0.5)).toBeCloseTo(0.75, 10);
    expect(blendChannel('screen', 0, 0.4)).toBeCloseTo(0.4, 10);
    // 1 + 0.4 - 0.4 is not exactly 1 in binary.
    expect(blendChannel('screen', 1, 0.4)).toBeCloseTo(1, 10);
  });

  it('overlay is hard light with the layers swapped', () => {
    for (const [cb, cs] of [[0.2, 0.7], [0.8, 0.3], [0.5, 0.5], [0.1, 0.9]]) {
      expect(blendChannel('overlay', cb, cs)).toBeCloseTo(blendChannel('hard-light', cs, cb), 10);
    }
  });

  it('darken and lighten pick a side', () => {
    expect(blendChannel('darken', 0.3, 0.7)).toBeCloseTo(0.3, 10);
    expect(blendChannel('lighten', 0.3, 0.7)).toBeCloseTo(0.7, 10);
  });

  it('colour dodge and burn take their edges exactly as the spec writes them', () => {
    expect(blendChannel('color-dodge', 0, 0.5)).toBe(0);
    expect(blendChannel('color-dodge', 0.5, 1)).toBe(1);
    expect(blendChannel('color-dodge', 0.25, 0.5)).toBeCloseTo(0.5, 10);
    expect(blendChannel('color-burn', 1, 0.5)).toBe(1);
    expect(blendChannel('color-burn', 0.5, 0)).toBe(0);
    expect(blendChannel('color-burn', 0.5, 0.5)).toBe(0);
  });

  it('hard light switches at the half-way point', () => {
    expect(blendChannel('hard-light', 0.6, 0.25)).toBeCloseTo(0.3, 10);
    expect(blendChannel('hard-light', 0.6, 0.75)).toBeCloseTo(0.8, 10);
  });

  it('soft light leaves a mid-grey layer alone and uses D(Cb) above it', () => {
    for (const cb of [0.1, 0.25, 0.4, 0.9]) {
      expect(blendChannel('soft-light', cb, 0.5)).toBeCloseTo(cb, 10);
    }
    // Above 0.25 the spec's D is a square root.
    expect(blendChannel('soft-light', 0.49, 1)).toBeCloseTo(0.7, 2);
  });

  it('difference and exclusion', () => {
    expect(blendChannel('difference', 0.3, 0.8)).toBeCloseTo(0.5, 10);
    expect(blendChannel('exclusion', 0.5, 0.5)).toBeCloseTo(0.5, 10);
    expect(blendChannel('exclusion', 1, 1)).toBeCloseTo(0, 10);
  });

  it('every mode keeps its result inside the range', () => {
    for (const mode of BLEND_MODES) {
      for (let cb = 0; cb <= 1.0001; cb += 0.1) {
        for (let cs = 0; cs <= 1.0001; cs += 0.1) {
          const value = blendChannel(mode, Math.min(1, cb), Math.min(1, cs));
          expect(value, `${mode} at ${cb.toFixed(1)}/${cs.toFixed(1)}`).toBeGreaterThanOrEqual(-1e-9);
          expect(value, `${mode} at ${cb.toFixed(1)}/${cs.toFixed(1)}`).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });
});

describe('a layer over the scene', () => {
  it('normal over an opaque backdrop is the layer itself', () => {
    expect(blendOver(opaque(0.2), opaque(0.8), 'normal')).toMatchObject({ r: 0.8, a: 1 });
  });

  it('a transparent layer changes nothing, whatever the mode', () => {
    for (const mode of BLEND_MODES) {
      const result = blendOver(opaque(0.4), { r: 0.9, g: 0.9, b: 0.9, a: 0 }, mode);
      expect(result.r, mode).toBeCloseTo(0.4, 10);
      expect(result.a, mode).toBeCloseTo(1, 10);
    }
  });

  it('over nothing, every mode leaves the layer as it is - the spec mixes the blend back', () => {
    for (const mode of BLEND_MODES) {
      const result = blendOver({ r: 0, g: 0, b: 0, a: 0 }, opaque(0.7), mode);
      expect(result.r, mode).toBeCloseTo(0.7, 10);
      expect(result.a, mode).toBeCloseTo(1, 10);
    }
  });

  it('opacity fades a blend in, from the backdrop to the full effect', () => {
    const full = blendOver(opaque(0.6), opaque(0.5), 'multiply');
    const half = blendOver(opaque(0.6), opaque(0.5), 'multiply', 0.5);
    expect(full.r).toBeCloseTo(0.3, 10);
    expect(half.r).toBeCloseTo((0.6 + 0.3) / 2, 10);
    expect(blendOver(opaque(0.6), opaque(0.5), 'multiply', 0).r).toBeCloseTo(0.6, 10);
  });

  it('alpha follows source-over whatever the blend does', () => {
    const result = blendOver({ r: 0.2, g: 0.2, b: 0.2, a: 0.5 }, { r: 0.8, g: 0.8, b: 0.8, a: 0.5 }, 'screen');
    expect(result.a).toBeCloseTo(0.75, 10);
  });

  it('gives the shader a number for every mode, with no repeats', () => {
    const numbers = BLEND_MODES.map((mode) => BLEND_MODE_INDEX[mode]);
    expect(new Set(numbers).size).toBe(BLEND_MODES.length);
    expect(BLEND_MODE_INDEX.normal).toBe(0);
    expect(Object.keys(BLEND_MODE_INDEX).sort()).toEqual([...BLEND_MODES].sort() as BlendMode[]);
  });
});

describe('a project opened from disk', () => {
  const projectWith = (blendMode: unknown) => {
    const base = createEmptyProject(1920, 1080, 30);
    const clip = createClip({
      trackId: base.tracks[0].id,
      name: 'shot',
      sourceUri: 'file:///shot.mp4',
      startFrame: 0,
      durationFrames: 60,
    });
    return { ...base, clips: { [clip.id]: { ...clip, blendMode } } } as never;
  };

  const modeOf = (blendMode: unknown) => {
    const project = normalizeProject(projectWith(blendMode));
    return Object.values(project.clips)[0].blendMode;
  };

  it('keeps a mode it knows', () => {
    for (const mode of BLEND_MODES) {
      expect(modeOf(mode) ?? 'normal', mode).toBe(mode);
    }
  });

  it("drops 'normal', which is what absent already means", () => {
    expect(modeOf('normal')).toBeUndefined();
  });

  it('opens a project written by a newer build rather than refusing it', () => {
    for (const value of ['hue', 'luminosity', '', 42, null, {}]) {
      expect(modeOf(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('leaves a clip made before blend modes existed alone', () => {
    expect(modeOf(undefined)).toBeUndefined();
  });
});

describe('the mode numbers', () => {
  it('are what the shader is told', () => {
    const numbers = BLEND_MODES.map((mode) => BLEND_MODE_INDEX[mode]);
    expect(new Set(numbers).size).toBe(BLEND_MODES.length);
    expect(BLEND_MODE_INDEX.normal).toBe(0);
    expect(Object.keys(BLEND_MODE_INDEX).sort()).toEqual([...BLEND_MODES].sort() as BlendMode[]);
  });
});
