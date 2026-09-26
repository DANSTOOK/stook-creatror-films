import { describe, expect, it } from 'vitest';
import { stepZoomView, wheelZoomFactor, ZOOM_TAU_MS } from '../src/renderer/components/Timeline/zoomMotion';
import { zoomAround } from '../src/renderer/components/Timeline/zoom';

/** Run the approach at 60 fps until it arrives; how long it took, and the path. */
function settle(from: { pixelsPerFrame: number; scrollLeftPx: number }, to: { pixelsPerFrame: number; scrollLeftPx: number }, width = 1200) {
  let shown = from;
  const path = [shown];
  let ms = 0;
  for (let i = 0; i < 200; i += 1) {
    const step = stepZoomView(shown, to, 16.7, width);
    shown = step.view;
    path.push(shown);
    ms += 16.7;
    if (!step.moving) break;
  }
  return { ms, path, end: shown };
}

describe('timeline zoom motion', () => {
  it('arrives exactly on the store value, fast: settled within about 160 ms', () => {
    const from = { pixelsPerFrame: 2, scrollLeftPx: 300 };
    const to = zoomAround(from, 1.25, 400);
    const { ms, end } = settle(from, to);
    expect(end).toEqual(to);
    expect(ms).toBeLessThanOrEqual(170);
    expect(ms).toBeGreaterThan(ZOOM_TAU_MS);
  });

  it('keeps the point under the pointer still on every frame, not only at the end', () => {
    const anchorPx = 400;
    const from = { pixelsPerFrame: 2, scrollLeftPx: 300 };
    const frameUnderPointer = (from.scrollLeftPx + anchorPx) / from.pixelsPerFrame;
    const to = zoomAround(from, 4, anchorPx);
    for (const view of settle(from, to).path) {
      expect((view.scrollLeftPx + anchorPx) / view.pixelsPerFrame).toBeCloseTo(frameUnderPointer, 6);
    }
  });

  it('retargets from where it is: a second notch mid-zoom carries on, it does not restart', () => {
    const from = { pixelsPerFrame: 2, scrollLeftPx: 0 };
    const first = zoomAround(from, 1.25, 0);
    const midway = stepZoomView(from, first, 30, 1200).view;
    const second = zoomAround(first, 1.25, 0);
    const next = stepZoomView(midway, second, 16.7, 1200).view;
    expect(next.pixelsPerFrame).toBeGreaterThan(midway.pixelsPerFrame);
    expect(next.pixelsPerFrame).toBeLessThan(second.pixelsPerFrame);
  });

  it('never animates a scroll on its own, and does nothing with reduced motion', () => {
    const shown = { pixelsPerFrame: 2, scrollLeftPx: 0 };
    const scrolled = { pixelsPerFrame: 2, scrollLeftPx: 5000 };
    expect(stepZoomView(shown, scrolled, 16.7, 1200)).toEqual({ view: scrolled, moving: false });
    const zoomed = { pixelsPerFrame: 8, scrollLeftPx: 0 };
    expect(stepZoomView(shown, zoomed, 16.7, 1200, true)).toEqual({ view: zoomed, moving: false });
  });

  it('a wheel notch still zooms by 1.25; a pinch zooms in proportion to its delta', () => {
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(1.25, 6);
    expect(wheelZoomFactor(100, 0)).toBeCloseTo(1 / 1.25, 6);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(Math.exp((99 * Math.log(1.25)) / 100), 6);
    // Ten small pinch events add up to one notch, not ten.
    let pinch = 1;
    for (let i = 0; i < 10; i += 1) pinch *= wheelZoomFactor(-10, 0);
    expect(pinch).toBeCloseTo(1.25, 6);
    expect(wheelZoomFactor(-1.5, 0)).toBeLessThan(1.01);
    // A huge delta is capped rather than jumping across the whole range.
    expect(wheelZoomFactor(-5000, 0)).toBe(2);
  });
});
