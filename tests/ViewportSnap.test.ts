import { describe, expect, it } from 'vitest';

import { quadCorners, snappedMove, snappedPosition, snappedScale } from '@renderer/components/PreviewViewport/viewportTransform';
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

/*
  "Put a limit in the viewer: a stretched picture does not stop at the edge
  of the frame." Moving already stuck to the centre (and, quietly, to the
  edges - always drawing the centre guide); scaling stuck to nothing.
*/
describe('moving: the picture as drawn lands on the frame, and says which line', () => {
  it('names the edge it landed on', () => {
    const half = transform({ scale: { x: 0.5, y: 0.5 } });
    const snapped = snappedMove({ x: -474, y: 0 }, half, frame, tolerance);
    expect(snapped.position.x).toBe(-480);
    expect(snapped.guides).toContainEqual({ axis: 'x', at: 0, kind: 'edge' });
  });

  it('measures the picture where it is drawn: an anchor off the middle moves the box', () => {
    // Anchored at its corner, a half-size picture sits in the top-right
    // quarter: its left edge is at the centre line, not 480px left of it.
    const corner = transform({ scale: { x: 0.5, y: 0.5 }, anchorPoint: { x: 0, y: 0 } });
    expect(Math.min(...quadCorners(corner, frame).map((point) => point.x))).toBeCloseTo(960, 6);
    const snapped = snappedMove({ x: -955, y: 0 }, corner, frame, tolerance);
    expect(snapped.position.x).toBe(-960);
    expect(snapped.guides.find((guide) => guide.axis === 'x')).toEqual({ axis: 'x', at: 0, kind: 'edge' });
  });

  it('a picture that fills the frame shows one guide per axis, the centre', () => {
    const snapped = snappedMove({ x: 6, y: -4 }, transform(), frame, tolerance);
    expect(snapped.guides).toEqual([
      { axis: 'x', at: 960, kind: 'centre' },
      { axis: 'y', at: 540, kind: 'centre' },
    ]);
  });
});

describe('scaling: the pulled edge stops at the frame', () => {
  // Half size, centred: the picture is 480..1440 across and 270..810 down.
  const half = transform({ scale: { x: 0.5, y: 0.5 } });

  it('the right grip pulled to just short of the right edge lands on it', () => {
    const result = snappedScale(half, 'right', { x: 1912, y: 540 }, frame, {}, undefined, tolerance);
    expect(result.scale.x).toBeCloseTo(0.75, 9);
    expect(result.scale.y).toBeCloseTo(0.5, 9);
    // The left edge has not moved.
    expect(Math.min(...quadCorners({ ...half, ...result }, frame).map((point) => point.x))).toBeCloseTo(480, 6);
    expect(result.guides).toEqual([{ axis: 'x', at: 1920, kind: 'edge' }]);
  });

  it('pulled on past the tolerance, it goes past - a punch-in is still one drag', () => {
    const result = snappedScale(half, 'right', { x: 2000, y: 540 }, frame, {}, undefined, tolerance);
    expect(result.scale.x).toBeCloseTo((2000 - 480) / 1920, 9);
    expect(result.guides).toEqual([]);
  });

  it('Alt - a tolerance of zero - is the exact pointer', () => {
    const result = snappedScale(half, 'right', { x: 1912, y: 540 }, frame, {}, undefined, 0);
    expect(result.scale.x).toBeCloseTo((1912 - 480) / 1920, 9);
    expect(result.guides).toEqual([]);
  });

  it('stops where the picture is exactly as wide as the frame, wherever that is', () => {
    // Left edge at 300: as wide as the frame puts the right edge at 2220.
    const shifted = transform({ scale: { x: 0.5, y: 0.5 }, position: { x: -180, y: 0 } });
    const result = snappedScale(shifted, 'right', { x: 2215, y: 540 }, frame, {}, undefined, tolerance);
    expect(result.scale.x).toBeCloseTo(1, 9);
    expect(result.guides).toEqual([{ axis: 'x', at: 2220, kind: 'size' }]);
  });

  it('a corner keeps the shape and stops on whichever edge is nearer - here both', () => {
    const result = snappedScale(half, 'bottomRight', { x: 1915, y: 1000 }, frame, {}, undefined, tolerance);
    expect(result.scale.x).toBeCloseTo(0.75, 9);
    expect(result.scale.y).toBeCloseTo(0.75, 9);
    expect(result.guides).toContainEqual({ axis: 'y', at: 1080, kind: 'edge' });
    expect(result.guides).toContainEqual({ axis: 'x', at: 1920, kind: 'edge' });
  });

  it('the bottom grip lands on the bottom edge, and on the centre line', () => {
    expect(snappedScale(half, 'bottom', { x: 960, y: 1074 }, frame, {}, undefined, tolerance).scale.y).toBeCloseTo((1080 - 270) / 1080, 9);
    // From the top edge at 270, the centre line is 270px down: a quarter of the frame.
    expect(snappedScale(half, 'bottom', { x: 960, y: 546 }, frame, {}, undefined, tolerance).scale.y).toBeCloseTo(0.25, 9);
  });

  it('a picture turned at an angle has no edge along the frame: nothing to stop on', () => {
    const turned = transform({ scale: { x: 0.5, y: 0.5 }, rotation: 30 });
    const result = snappedScale(turned, 'right', { x: 1912, y: 540 }, frame, {}, undefined, tolerance);
    expect(result.guides).toEqual([]);
  });
});

/*
  Rescued onto v1.41: the cases the box "as drawn" is for - a picture turned
  upside down or flipped has its grips and edges on the other side, and the
  snapping has to follow the picture, not its numbers.
*/
describe('turned or flipped, the box as drawn is what lands', () => {
  const half = (overrides: Partial<ResolvedTransform> = {}) => transform({ scale: { x: 0.5, y: 0.5 }, ...overrides });

  it('a flipped picture moved near the right edge lands flush on it', () => {
    const flipped = half({ scale: { x: -0.5, y: 0.5 } });
    const snapped = snappedMove({ x: 476, y: 0 }, flipped, frame, tolerance);
    expect(snapped.position.x).toBe(480);
    expect(snapped.guides).toEqual([{ axis: 'x', at: 1920, kind: 'edge' }, { axis: 'y', at: 540, kind: 'centre' }]);
  });

  it('upside down, the right grip is on the left: pulled to the left edge, it stops there', () => {
    const upsideDown = half({ rotation: 180 });
    const result = snappedScale(upsideDown, 'right', { x: 8, y: 540 }, frame, {}, undefined, tolerance);
    // The edge that stays put is the drawn right one, at 1440.
    const box = quadCorners({ ...upsideDown, ...result }, frame).map((point) => point.x);
    expect(Math.min(...box)).toBeCloseTo(0, 6);
    expect(Math.max(...box)).toBeCloseTo(1440, 6);
    expect(result.guides).toEqual([{ axis: 'x', at: 0, kind: 'edge' }]);
  });
});
