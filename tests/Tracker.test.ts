import { describe, expect, it } from 'vitest';
import { MIN_MATCH, TemplateTracker } from '../src/main/media/tracker';

const W = 320;
const H = 180;

/** A noisy grey frame with a textured square at (cx, cy). */
function frameWith(cx: number, cy: number, seed = 1, occluded = false, size = 1): Uint8Array {
  const frame = new Uint8Array(W * H);
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = 0; i < frame.length; i += 1) frame[i] = 90 + Math.floor(rnd() * 30);
  if (!occluded) {
    const half = Math.round(12 * size);
    for (let y = -half; y < half; y += 1) {
      for (let x = -half; x < half; x += 1) {
        const px = Math.round(cx + x);
        const py = Math.round(cy + y);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        // A checker inside a bright ring: something with a shape to find, drawn at `size`.
        const u = x / size;
        const v = y / size;
        const ring = Math.max(Math.abs(u), Math.abs(v)) >= 10;
        frame[py * W + px] = ring ? 250 : (Math.floor((u + 12) / 4) + Math.floor((v + 12) / 4)) % 2 ? 30 : 200;
      }
    }
  }
  return frame;
}

describe('following a thing', () => {
  it('follows it across the frame, frame by frame, within a pixel', () => {
    const tracker = new TemplateTracker(frameWith(60, 90), W, H, { x: 60, y: 90, width: 24, height: 24 });
    let worst = 0;
    for (let i = 1; i <= 60; i += 1) {
      const x = 60 + i * 3;
      const y = 90 + Math.sin(i / 8) * 30;
      const point = tracker.next(frameWith(x, y, i + 1));
      worst = Math.max(worst, Math.hypot(point.x - x, point.y - y));
      expect(point.score).toBeGreaterThan(MIN_MATCH);
    }
    expect(worst).toBeLessThanOrEqual(1.5);
  });

  it('follows a thing coming closer at the size it now is, and a still one stays its size', () => {
    const tracker = new TemplateTracker(frameWith(160, 90), W, H, { x: 160, y: 90, width: 24, height: 24 });
    let point = { x: 0, y: 0, score: 0, scale: 1 };
    for (let i = 1; i <= 40; i += 1) point = tracker.next(frameWith(160, 90, i + 1, false, 1 + i * 0.0125));
    // Grown by half over 40 frames.
    expect(point.scale).toBeGreaterThan(1.38);
    expect(point.scale).toBeLessThan(1.62);
    expect(Math.hypot(point.x - 160, point.y - 90)).toBeLessThanOrEqual(1.5);
    const still = new TemplateTracker(frameWith(100, 90), W, H, { x: 100, y: 90, width: 24, height: 24 });
    let resting = { x: 0, y: 0, score: 0, scale: 1 };
    for (let i = 1; i <= 30; i += 1) resting = still.next(frameWith(100, 90, i + 1));
    expect(resting.scale).toBeCloseTo(1, 5);
  });

  it('keeps its place when the thing is hidden for a moment, and finds it again after', () => {
    const tracker = new TemplateTracker(frameWith(100, 90), W, H, { x: 100, y: 90, width: 24, height: 24 });
    tracker.next(frameWith(103, 90, 2));
    const hidden = tracker.next(frameWith(106, 90, 3, true));
    expect(hidden.score).toBeLessThan(MIN_MATCH);
    expect(Math.abs(hidden.x - 103)).toBeLessThanOrEqual(1.5);
    const back = tracker.next(frameWith(109, 90, 4));
    expect(back.score).toBeGreaterThan(MIN_MATCH);
    expect(Math.abs(back.x - 109)).toBeLessThanOrEqual(1.5);
  });
});
