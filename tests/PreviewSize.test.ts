import { describe, expect, it } from 'vitest';
import { previewSize } from '../src/renderer/engine/previewSize';

const uhd = { width: 3840, height: 2160 };

describe('how many pixels the viewer draws', () => {
  it('draws the whole frame while paused, whatever the quality', () => {
    expect(previewSize(uhd, { playing: false, quality: 'quarter', display: { width: 960, height: 540 } })).toEqual(uhd);
  });

  it('playing on auto, draws what the viewer shows', () => {
    expect(previewSize(uhd, { playing: true, quality: 'auto', display: { width: 1000, height: 562.5 } })).toEqual({ width: 1000, height: 562 });
  });

  it('keeps the whole frame when the viewer shows nearly all of it', () => {
    const hd = { width: 1920, height: 1080 };
    expect(previewSize(hd, { playing: true, quality: 'auto', display: { width: 1700, height: 956 } })).toEqual(hd);
  });

  it('draws the fraction asked for', () => {
    expect(previewSize(uhd, { playing: true, quality: 'half', display: null })).toEqual({ width: 1920, height: 1080 });
    expect(previewSize(uhd, { playing: true, quality: 'quarter', display: null })).toEqual({ width: 960, height: 540 });
    expect(previewSize(uhd, { playing: true, quality: 'full', display: { width: 500, height: 281 } })).toEqual(uhd);
  });

  it('never fewer than 270 lines, and pixel art keeps every pixel', () => {
    expect(previewSize(uhd, { playing: true, quality: 'auto', display: { width: 200, height: 112 } }).height).toBe(270);
    expect(previewSize(uhd, { playing: true, quality: 'quarter', display: null, exact: true })).toEqual(uhd);
  });

  it('without a measured viewer, auto draws the whole frame', () => {
    expect(previewSize(uhd, { playing: true, quality: 'auto', display: null })).toEqual(uhd);
  });
});
