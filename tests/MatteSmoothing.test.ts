import { describe, expect, it } from 'vitest';
import { MatteSmoother, blendWithPrevious, flickerRate, median3, temporalChange } from '@shared/matte/smoothing';

const flat = (value: number, length = 16): Uint8Array => new Uint8Array(length).fill(value);

function run(frames: Uint8Array[]): Uint8Array[] {
  const smoother = new MatteSmoother();
  const out: Uint8Array[] = [];
  for (const frame of frames) {
    const result = smoother.push(frame);
    if (result) out.push(result);
  }
  const last = smoother.finish();
  if (last) out.push(last);
  return out;
}

describe('temporal smoothing of mattes', () => {
  it('hands back one frame for every frame in, in order', () => {
    const frames = [0, 50, 100, 150, 200].map((value) => flat(value));
    const out = run(frames);
    expect(out).toHaveLength(5);
    // A steady change is movement and is followed, not held back.
    expect(out.map((frame) => frame[0])).toEqual([0, 50, 100, 150, 200]);
  });

  it('removes a hole that opens for a single frame, however deep', () => {
    const frames = [255, 255, 0, 255, 255].map((value) => flat(value));
    expect(run(frames).map((frame) => frame[0])).toEqual([255, 255, 255, 255, 255]);
  });

  it('follows a cut at once', () => {
    const frames = [255, 255, 255, 0, 0, 0].map((value) => flat(value));
    expect(run(frames).map((frame) => frame[0])).toEqual([255, 255, 255, 0, 0, 0]);
  });

  it('evens out small jitter and leaves large changes alone', () => {
    const previous = new Uint8Array([100, 100, 0]);
    const current = new Uint8Array([110, 90, 255]);
    blendWithPrevious(previous, current, { strength: 0.5, tolerance: 0.2, cut: 1 });
    // A change of 10 (4% of full scale) is pulled most of the way back...
    expect(Math.abs(current[0] - 100)).toBeLessThan(10);
    expect(Math.abs(current[1] - 100)).toBeLessThan(10);
    // ...a change of 255 is movement, and is kept.
    expect(current[2]).toBe(255);
  });

  it('measurably lowers the flicker of a flickering sequence', () => {
    // A still subject (255) on background (0) whose edge pixels pop in and out.
    const frames: Uint8Array[] = [];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let index = 0; index < 60; index += 1) {
      const frame = new Uint8Array(400);
      for (let pixel = 0; pixel < frame.length; pixel += 1) {
        const subject = pixel % 20 < 10;
        frame[pixel] = subject ? 255 : 0;
        if (random() < 0.05) frame[pixel] = 255 - frame[pixel];
      }
      frames.push(frame);
    }
    const before = flickerRate(frames);
    const after = flickerRate(run(frames));
    expect(before).toBeGreaterThan(0.03);
    expect(after).toBeLessThan(before / 5);
    expect(temporalChange(run(frames))).toBeLessThan(temporalChange(frames) / 3);
  });

  it('counts only one-frame excursions as flicker, not movement', () => {
    expect(flickerRate([flat(0), flat(100), flat(200)])).toBe(0);
    expect(flickerRate([flat(0), flat(200), flat(0)])).toBe(1);
  });

  it('takes the median of three per pixel', () => {
    expect([...median3(new Uint8Array([1, 9, 5]), new Uint8Array([5, 1, 9]), new Uint8Array([9, 5, 1]))]).toEqual([5, 5, 5]);
  });
});
