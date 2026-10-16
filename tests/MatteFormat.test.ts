import { describe, expect, it } from 'vitest';
import {
  MATTE_HEADER_BYTES,
  decodeMatteFrame,
  encodeMatteFrame,
  matteFrameFor,
  matteSize,
  readMatteHeader,
  readMatteIndex,
  writeMatteHeader,
  writeMatteIndex,
} from '@shared/matte/format';

/** A matte as the models make them: background, a soft edge, the subject. */
function softDisc(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - width / 2, y - height / 2);
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round((height / 3 - distance) * 32 + 128)));
    }
  }
  return pixels;
}

describe('matte frames, run-length coded', () => {
  it('decodes to exactly what was encoded', () => {
    const cases = [
      softDisc(64, 36),
      new Uint8Array(1000), // all background
      new Uint8Array(1000).fill(255), // all subject
      Uint8Array.from({ length: 777 }, (_, index) => (index * 37) % 256), // no runs at all
      Uint8Array.from({ length: 515 }, (_, index) => (index % 5 < 2 ? 9 : index % 7)), // runs of two
      new Uint8Array([1]),
    ];
    for (const pixels of cases) {
      const decoded = new Uint8Array(pixels.length);
      expect(decodeMatteFrame(encodeMatteFrame(pixels), decoded)).toBe(true);
      expect(decoded).toEqual(pixels);
    }
  });

  it('shrinks a real-looking matte many times over', () => {
    const pixels = softDisc(1024, 576);
    expect(encodeMatteFrame(pixels).length).toBeLessThan(pixels.length / 10);
  });

  it('refuses a frame that does not fill the picture exactly', () => {
    const coded = encodeMatteFrame(new Uint8Array(100).fill(7));
    expect(decodeMatteFrame(coded, new Uint8Array(99))).toBe(false);
    expect(decodeMatteFrame(coded, new Uint8Array(101))).toBe(false);
    expect(decodeMatteFrame(coded.subarray(0, coded.length - 1), new Uint8Array(100))).toBe(false);
  });
});

describe('the matte file header and index', () => {
  it('reads back what was written', () => {
    const header = { width: 1024, height: 576, frames: 300, fps: 29.97, indexOffset: 123_456 };
    const bytes = writeMatteHeader(header);
    expect(bytes.length).toBe(MATTE_HEADER_BYTES);
    expect(readMatteHeader(bytes)).toEqual(header);
    const offsets = [64, 100, 250, 251];
    expect(readMatteIndex(writeMatteIndex(offsets), 3)).toEqual(offsets);
  });

  it('does not take an unfinished or foreign file for a matte file', () => {
    // The worker writes zeros first and the real header last.
    expect(readMatteHeader(new Uint8Array(MATTE_HEADER_BYTES))).toBeNull();
    expect(readMatteHeader(writeMatteHeader({ width: 4, height: 4, frames: 0, fps: 30, indexOffset: 64 }))).toBeNull();
    const other = writeMatteHeader({ width: 4, height: 4, frames: 2, fps: 30, indexOffset: 64 });
    other[0] = 0x50;
    expect(readMatteHeader(other)).toBeNull();
    // An index that goes backwards is damaged.
    expect(readMatteIndex(writeMatteIndex([64, 50, 80]), 2)).toBeNull();
  });
});

describe('matte sizes and timing', () => {
  it('keeps the shape, long edge at 1024, never larger than the source, both sides even', () => {
    expect(matteSize(3840, 2160)).toEqual({ width: 1024, height: 576 });
    expect(matteSize(1280, 720)).toEqual({ width: 1024, height: 576 });
    expect(matteSize(1080, 1920)).toEqual({ width: 576, height: 1024 });
    expect(matteSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(matteSize(641, 359)).toEqual({ width: 642, height: 360 });
    expect(matteSize(0, 0)).toEqual({ width: 2, height: 2 });
  });

  it('gives frame N of footage the matte of frame N at the same rate', () => {
    for (let frame = 0; frame < 300; frame += 1) expect(matteFrameFor(frame, 30, 30, 300)).toBe(frame);
    expect(matteFrameFor(777, 29.97, 29.97, 1000)).toBe(777);
  });

  it('maps across rates by time, the picture on screen at the middle of the frame', () => {
    // A 60 fps file on a 30 fps timeline: frame 10 is at 0.35 s, the 60 fps frame 21.
    expect(matteFrameFor(10, 30, 60, 600)).toBe(21);
    // A 24 fps file on a 30 fps timeline: 0.35 s is the 24 fps frame 8.
    expect(matteFrameFor(10, 30, 24, 240)).toBe(8);
  });

  it('stays inside the file, and a still has its one matte', () => {
    expect(matteFrameFor(10_000, 30, 30, 300)).toBe(299);
    expect(matteFrameFor(-5, 30, 30, 300)).toBe(0);
    expect(matteFrameFor(123, 30, 1, 1)).toBe(0);
  });
});
