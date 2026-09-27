import { describe, expect, it } from 'vitest';
import {
  LEVELS,
  VECTOR_SIZE,
  VECTOR_TARGETS,
  chroma709,
  computeScopes,
  luma709,
  vectorCellOf,
  type ScopeFrame,
  type ScopeKind,
} from '@renderer/scopes/scopeMath';

/** A frame filled by `colourAt(x, y)`. */
function frame(width: number, height: number, colourAt: (x: number, y: number) => [number, number, number]): ScopeFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colourAt(x, y);
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return { rgba, width, height };
}

const ALL = new Set<ScopeKind>(['waveform', 'parade', 'vectorscope', 'histogram']);

/** The levels a waveform column has pixels at. */
function levelsIn(bins: Uint32Array, width: number, column: number): number[] {
  const levels: number[] = [];
  for (let level = 0; level < LEVELS; level += 1) if (bins[level * width + column] > 0) levels.push(level);
  return levels;
}

describe('video scopes on known patterns', () => {
  it('draws 50% grey as one line at 50% on the waveform, one dot at the centre of the vectorscope', () => {
    const grey = frame(64, 36, () => [128, 128, 128]);
    const data = computeScopes(grey, ALL);

    for (let x = 0; x < 64; x += 1) {
      expect(levelsIn(data.waveform!, 64, x)).toEqual([128]);
      expect(data.waveform![128 * 64 + x]).toBe(36);
    }
    const centre = (VECTOR_SIZE / 2) * VECTOR_SIZE + VECTOR_SIZE / 2;
    expect(data.vectorscope![centre]).toBe(64 * 36);
    expect(data.histogram!.y[128]).toBe(64 * 36);
  });

  it('shows pure red at the top of the red parade and at the bottom of green and blue', () => {
    const red = frame(32, 18, () => [255, 0, 0]);
    const data = computeScopes(red, ALL);
    const [r, g, b] = data.parade!;
    for (let x = 0; x < 32; x += 1) {
      expect(levelsIn(r, 32, x)).toEqual([255]);
      expect(levelsIn(g, 32, x)).toEqual([0]);
      expect(levelsIn(b, 32, x)).toEqual([0]);
    }
    // Its luma is BT.709's red weight: 0.2126 of full scale.
    expect(levelsIn(data.waveform!, 32, 0)).toEqual([Math.round(0.2126 * 255)]);
  });

  it('turns a ramp into a flat histogram and a diagonal waveform', () => {
    const ramp = frame(256, 10, (x) => [x, x, x]);
    const data = computeScopes(ramp, ALL);
    for (let level = 0; level < LEVELS; level += 1) {
      expect(data.histogram!.r[level]).toBe(10);
      expect(data.histogram!.g[level]).toBe(10);
      expect(data.histogram!.b[level]).toBe(10);
      expect(data.histogram!.y[level]).toBe(10);
    }
    for (let x = 0; x < 256; x += 17) expect(levelsIn(data.waveform!, 256, x)).toEqual([x]);
  });

  /*
    The published Y'CbCr of 75% HD colour bars (SMPTE RP 219, BT.709,
    8-bit): an independent reference for the chroma the vectorscope plots.
  */
  const RP219: Record<string, [number, number, number]> = {
    Yl: [168, 44, 136],
    Cy: [145, 147, 44],
    G: [133, 63, 52],
    Mg: [63, 193, 204],
    R: [51, 109, 212],
    B: [28, 212, 120],
  };

  it('computes the BT.709 luma and chroma of the 75% bars as SMPTE RP 219 publishes them', () => {
    for (const target of VECTOR_TARGETS) {
      const [r, g, b] = target.rgb;
      const { cb, cr } = chroma709(r, g, b);
      const y = luma709(r, g, b) / 255;
      const coded = [Math.round(16 + 219 * y), Math.round(128 + 224 * cb), Math.round(128 + 224 * cr)];
      expect(coded).toEqual(RP219[target.label]);
    }
  });

  it('lands every 75% bar in its target', () => {
    const bars = frame(VECTOR_TARGETS.length * 10, 8, (x) => [...VECTOR_TARGETS[Math.floor(x / 10)].rgb] as [number, number, number]);
    const data = computeScopes(bars, new Set(['vectorscope']));
    for (const target of VECTOR_TARGETS) {
      const { column, row } = vectorCellOf(...target.rgb);
      expect(data.vectorscope![row * VECTOR_SIZE + column]).toBe(10 * 8);
    }
    // Only the six targets are lit.
    expect([...data.vectorscope!].filter((count) => count > 0)).toHaveLength(6);
  });

  it('puts red up and to the left, and blue to the right, as every vectorscope does', () => {
    const red = vectorCellOf(191, 0, 0);
    const blue = vectorCellOf(0, 0, 191);
    const centre = VECTOR_SIZE / 2;
    expect(red.row).toBeLessThan(centre);
    expect(red.column).toBeLessThan(centre);
    expect(blue.column).toBeGreaterThan(centre);
  });

  it('only measures what is asked for', () => {
    const data = computeScopes(frame(4, 4, () => [10, 20, 30]), new Set(['histogram']));
    expect(data.histogram).toBeDefined();
    expect(data.waveform).toBeUndefined();
    expect(data.parade).toBeUndefined();
    expect(data.vectorscope).toBeUndefined();
  });
});
