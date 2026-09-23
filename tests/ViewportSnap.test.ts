import { describe, expect, it } from 'vitest';

import { snappedPosition } from '@renderer/components/PreviewViewport/viewportTransform';
import type { ResolvedTransform } from '@shared/types';

/**
 * The magnet in the viewer: what a dragged picture lands on.
 *
 * Centring a shot by eye is a game of one pixel at a time, so a drag sticks to
 * the middle of the frame and to the frame's own edges. The rules are here,
 * away from the pointer events, so they can be checked without one.
 */

const frame = { width: 1920, height: 1080 };

const transform = (overrides: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  opacity: 1,
  anchorPoint: { x: 0.5, y: 0.5 },
  ...overrides,
});

const tolerance = frame.width * 0.01; // 19.2 px, the app's own figure

describe('landing on the centre', () => {
  it('pulls a near miss onto it, and says which guide to draw', () => {
    const snapped = snappedPosition({ x: 8, y: -5 }, transform(), frame, tolerance);
    expect(snapped.position).toEqual({ x: 0, y: 0 });
    expect(snapped).toMatchObject({ vertical: true, horizontal: true });
  });

  it('leaves a drag that meant somewhere else alone', () => {
    const snapped = snappedPosition({ x: 300, y: -220 }, transform(), frame, tolerance);
    expect(snapped.position).toEqual({ x: 300, y: -220 });
    expect(snapped).toMatchObject({ vertical: false, horizontal: false });
  });

  it('can catch one axis without touching the other', () => {
    const snapped = snappedPosition({ x: 5, y: 400 }, transform(), frame, tolerance);
    expect(snapped.position).toEqual({ x: 0, y: 400 });
    expect(snapped).toMatchObject({ vertical: true, horizontal: false });
  });
});

describe('landing on the edges of the frame', () => {
  it('puts a half-size picture flush against either side', () => {
    // At half scale there is a quarter of the frame spare on each side: 480px.
    const half = transform({ scale: { x: 0.5, y: 0.5 } });
    expect(snappedPosition({ x: -474, y: 0 }, half, frame, tolerance).position.x).toBe(-480);
    expect(snappedPosition({ x: 486, y: 0 }, half, frame, tolerance).position.x).toBe(480);
    expect(snappedPosition({ x: 0, y: -268 }, half, frame, tolerance).position.y).toBe(-270);
  });

  it('has nothing to offer a picture that fills the frame', () => {
    // At scale 1 the edges are the centre: one candidate, not three.
    const snapped = snappedPosition({ x: 100, y: 0 }, transform(), frame, tolerance);
    expect(snapped.position.x).toBe(100);
  });

  it('measures the spare room from the scale it is actually at', () => {
    const big = transform({ scale: { x: 2, y: 2 } });
    // Twice the frame: an edge lines up 960px off centre, either way.
    expect(snappedPosition({ x: 955, y: 0 }, big, frame, tolerance).position.x).toBe(960);
  });

  it('is not fooled by a negative scale', () => {
    const flipped = transform({ scale: { x: -0.5, y: 0.5 } });
    expect(snappedPosition({ x: -476, y: 0 }, flipped, frame, tolerance).position.x).toBe(-480);
  });
});

describe('turning the magnet off', () => {
  it('is what a tolerance of zero means', () => {
    const snapped = snappedPosition({ x: 3, y: 2 }, transform(), frame, 0);
    expect(snapped.position).toEqual({ x: 3, y: 2 });
    expect(snapped).toMatchObject({ vertical: false, horizontal: false });
  });
});

describe('when two lines are within reach', () => {
  it('takes the nearer one', () => {
    // A picture barely smaller than the frame: centre and edge are close
    // together, and the drag should land on whichever it was nearer.
    const nearly = transform({ scale: { x: 0.99, y: 1 } });
    const spare = (frame.width * (1 - 0.99)) / 2; // 9.6px
    expect(snappedPosition({ x: spare - 1, y: 0 }, nearly, frame, tolerance).position.x).toBeCloseTo(spare, 5);
    expect(snappedPosition({ x: 1, y: 0 }, nearly, frame, tolerance).position.x).toBe(0);
  });
});
