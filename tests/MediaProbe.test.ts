import { describe, expect, it } from 'vitest';
import { hasTransparentPixels } from '@renderer/engine/probeMedia';

/** Build an RGBA buffer where every pixel carries the given alpha. */
const rgba = (alphas: number[]): Uint8ClampedArray =>
  Uint8ClampedArray.from(alphas.flatMap((alpha) => [255, 0, 0, alpha]));

describe('hasTransparentPixels', () => {
  it('reports opaque for a fully opaque buffer', () => {
    expect(hasTransparentPixels(rgba([255, 255, 255, 255]))).toBe(false);
  });

  it('detects a single transparent pixel anywhere in the buffer', () => {
    expect(hasTransparentPixels(rgba([255, 255, 0, 255]))).toBe(true);
    expect(hasTransparentPixels(rgba([0, 255, 255, 255]))).toBe(true);
    expect(hasTransparentPixels(rgba([255, 255, 255, 0]))).toBe(true);
  });

  it('detects partial transparency, not just fully clear pixels', () => {
    expect(hasTransparentPixels(rgba([255, 128, 255]))).toBe(true);
  });

  it('tolerates near-opaque pixels so codec rounding is not read as alpha', () => {
    // An opaque video decoded through a lossy path can land a hair under 255.
    expect(hasTransparentPixels(rgba([254, 253, 252]))).toBe(false);
    expect(hasTransparentPixels(rgba([249]))).toBe(true);
  });

  it('honours an explicit tolerance', () => {
    expect(hasTransparentPixels(rgba([200]), 128)).toBe(false);
    expect(hasTransparentPixels(rgba([100]), 128)).toBe(true);
  });

  it('reports opaque for an empty buffer', () => {
    expect(hasTransparentPixels(new Uint8ClampedArray(0))).toBe(false);
  });

  it('only inspects the alpha byte, never the colour bytes', () => {
    // Every colour channel is zero but alpha is full: this is opaque black.
    expect(hasTransparentPixels(Uint8ClampedArray.from([0, 0, 0, 255]))).toBe(false);
  });
});
