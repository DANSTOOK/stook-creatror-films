import { describe, expect, it } from 'vitest';
import {
  angleAround,
  containsPoint,
  handlePositions,
  movedPosition,
  quadCorners,
  rotationFromPointer,
  scaleFromHandle,
} from '../src/renderer/components/PreviewViewport/viewportTransform';
import type { ResolvedTransform } from '../src/shared/types';

const FRAME = { width: 1920, height: 1080 };

const transform = (patch: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  opacity: 1,
  anchorPoint: { x: 0.5, y: 0.5 },
  ...patch,
});

const near = (a: number, b: number, tolerance = 0.01): boolean => Math.abs(a - b) <= tolerance;
const pointNear = (point: { x: number; y: number }, x: number, y: number, tolerance = 0.01): boolean =>
  near(point.x, x, tolerance) && near(point.y, y, tolerance);

describe('the clip quad, as the compositor draws it', () => {
  it('fills the frame at scale 1, centred', () => {
    const [bottomLeft, bottomRight, topRight, topLeft] = quadCorners(transform(), FRAME);
    expect(pointNear(bottomLeft, 0, 1080)).toBe(true);
    expect(pointNear(bottomRight, 1920, 1080)).toBe(true);
    expect(pointNear(topRight, 1920, 0)).toBe(true);
    expect(pointNear(topLeft, 0, 0)).toBe(true);
  });

  it('halves to the middle at scale 0.5', () => {
    const corners = quadCorners(transform({ scale: { x: 0.5, y: 0.5 } }), FRAME);
    expect(pointNear(corners[0], 480, 810)).toBe(true);
    expect(pointNear(corners[2], 1440, 270)).toBe(true);
  });

  it('moves by position, in project pixels with y down', () => {
    const corners = quadCorners(transform({ scale: { x: 0.5, y: 0.5 }, position: { x: 100, y: 50 } }), FRAME);
    expect(pointNear(corners[0], 580, 860)).toBe(true);
  });

  it('rotates clockwise on screen for a positive angle', () => {
    // A quarter turn clockwise puts the top-left corner where the bottom-left was.
    const corners = quadCorners(transform({ rotation: 90 }), FRAME);
    const centre = { x: 960, y: 540 };
    expect(near(corners[3].x - centre.x, -(1080 / 2) * -1, 0.5)).toBe(false); // sanity: it did move
    // The clip's own width axis now points down the screen.
    const widthAxis = { x: corners[1].x - corners[0].x, y: corners[1].y - corners[0].y };
    expect(near(widthAxis.x, 0, 0.5)).toBe(true);
    expect(widthAxis.y).toBeGreaterThan(0);
  });

  it('pivots about the anchor point when it is not the centre', () => {
    const topLeftAnchor = transform({ anchorPoint: { x: 0, y: 1 }, scale: { x: 0.5, y: 0.5 } });
    const corners = quadCorners(topLeftAnchor, FRAME);
    // With the anchor at the clip's top-left and position 0, that corner sits
    // at the centre of the frame.
    expect(pointNear(corners[3], 960, 540)).toBe(true);
  });
});

describe('dragging the picture', () => {
  it('moves it by the pointer delta', () => {
    expect(movedPosition(transform({ position: { x: 10, y: -5 } }), { x: 30, y: 12 })).toEqual({ x: 40, y: 7 });
  });

  it('knows whether a point is on the clip', () => {
    const half = transform({ scale: { x: 0.5, y: 0.5 } });
    expect(containsPoint(half, { x: 960, y: 540 }, FRAME)).toBe(true);
    expect(containsPoint(half, { x: 100, y: 100 }, FRAME)).toBe(false);
    // Rotated, the corners of the old box are outside the new one.
    const turned = transform({ scale: { x: 0.5, y: 0.5 }, rotation: 45 });
    expect(containsPoint(turned, { x: 960, y: 540 }, FRAME)).toBe(true);
    expect(containsPoint(turned, { x: 481, y: 811 }, FRAME)).toBe(false);
  });
});

describe('scaling from a handle', () => {
  it('keeps the opposite corner where it is', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 } });
    // Top-right corner starts at (1440, 270); drag it to (1660, 160).
    const result = scaleFromHandle(start, 'topRight', { x: 1660, y: 160 }, FRAME, { free: true });
    const after = quadCorners({ ...start, ...result }, FRAME);
    expect(pointNear(after[0], 480, 810, 0.5)).toBe(true); // bottom-left unmoved
    expect(pointNear(after[2], 1660, 160, 0.5)).toBe(true); // corner followed the pointer
  });

  it('keeps the proportions from a corner unless asked not to', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 } });
    const free = scaleFromHandle(start, 'topRight', { x: 1660, y: 260 }, FRAME, { free: true });
    expect(near(free.scale.x, 1180 / 1920, 0.002)).toBe(true);
    expect(near(free.scale.y, 550 / 1080, 0.002)).toBe(true);

    const locked = scaleFromHandle(start, 'topRight', { x: 1660, y: 260 }, FRAME);
    expect(near(locked.scale.x / locked.scale.y, start.scale.x / start.scale.y, 0.001)).toBe(true);
    const after = quadCorners({ ...start, ...locked }, FRAME);
    expect(pointNear(after[0], 480, 810, 0.5)).toBe(true);
  });

  it('changes one axis only from an edge, keeping the other centred', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 } });
    const result = scaleFromHandle(start, 'right', { x: 1700, y: 540 }, FRAME);
    expect(near(result.scale.y, 0.5)).toBe(true);
    const after = quadCorners({ ...start, ...result }, FRAME);
    expect(near(after[0].x, 480, 0.5)).toBe(true); // left edge stayed
    expect(near(after[1].x, 1700, 0.5)).toBe(true); // right edge followed
    expect(near(after[0].y, 810, 0.5)).toBe(true); // vertically unchanged
  });

  it('never scales to nothing', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 } });
    const result = scaleFromHandle(start, 'topRight', { x: 480, y: 810 }, FRAME, { free: true });
    expect(result.scale.x).toBeGreaterThan(0);
    expect(result.scale.y).toBeGreaterThan(0);
  });

  it('works on a rotated clip, along the clip\'s own axes', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 }, rotation: 90 });
    const corners = quadCorners(start, FRAME);
    const fixedBefore = corners[0];
    const result = scaleFromHandle(start, 'topRight', corners[2], FRAME, { free: true });
    // Dragging a corner to exactly where it already is changes nothing.
    expect(near(result.scale.x, 0.5, 0.005)).toBe(true);
    expect(near(result.scale.y, 0.5, 0.005)).toBe(true);
    const after = quadCorners({ ...start, ...result }, FRAME);
    expect(pointNear(after[0], fixedBefore.x, fixedBefore.y, 0.5)).toBe(true);
  });
});

describe('rotating', () => {
  it('follows the pointer around the anchor', () => {
    const start = transform({ scale: { x: 0.5, y: 0.5 } });
    const grabAngle = angleAround(start, { x: 960, y: 200 }, FRAME);
    const turned = rotationFromPointer(start, { x: 1300, y: 540 }, FRAME, { grabAngle });
    expect(near(turned, 90, 0.01)).toBe(true);
  });

  it('snaps when asked', () => {
    const start = transform();
    const grabAngle = angleAround(start, { x: 960, y: 200 }, FRAME);
    const turned = rotationFromPointer(start, { x: 1300, y: 500 }, FRAME, { grabAngle, snapDegrees: 15 });
    expect(turned % 15).toBe(0);
  });
});

describe('where the grips are drawn', () => {
  it('puts them on the corners and the middles of the edges', () => {
    const grips = handlePositions(transform({ scale: { x: 0.5, y: 0.5 } }), FRAME);
    expect(pointNear(grips.bottomLeft, 480, 810)).toBe(true);
    expect(pointNear(grips.topRight, 1440, 270)).toBe(true);
    expect(pointNear(grips.right, 1440, 540)).toBe(true);
    expect(pointNear(grips.top, 960, 270)).toBe(true);
  });
});
