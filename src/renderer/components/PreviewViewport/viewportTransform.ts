import type { ResolvedTransform, Vector2D } from '@shared/types';

/**
 * The maths behind dragging a clip around in the viewer.
 *
 * The public surface speaks project pixels - origin top-left, y down, the same
 * space as the inspector's Position field - because that is what a pointer
 * gives us. Inside, everything happens in the compositor's own normalised
 * space (-1..1 across the frame, y up), which is where the transform is
 * actually defined.
 *
 * That distinction is not pedantry. Rotation is applied in normalised space,
 * where x and y do not have the same pixel density: on a 1920x1080 frame, a
 * clip turned a quarter turn has its own width axis measuring 540 screen
 * pixels, not 960. Measuring a drag in screen pixels therefore scales rotated
 * clips wrongly - which is exactly what the unit tests caught.
 */

export interface Point {
  x: number;
  y: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** Which grip is being dragged. Corners scale both axes, edges one. */
export type Handle = 'bottomLeft' | 'bottomRight' | 'topRight' | 'topLeft' | 'left' | 'right' | 'top' | 'bottom';

export const CORNER_HANDLES: Handle[] = ['bottomLeft', 'bottomRight', 'topRight', 'topLeft'];
export const EDGE_HANDLES: Handle[] = ['left', 'right', 'top', 'bottom'];

/** A clip never scales below this fraction of the frame, so a grip stays grabbable. */
const MIN_SCALE = 0.01;

const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const times = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const length = (a: Point): number => Math.hypot(a.x, a.y);
const normalise = (a: Point): Point => {
  const size = length(a);
  return size < 1e-9 ? { x: 1, y: 0 } : { x: a.x / size, y: a.y / size };
};

/** Project pixels (y down) to the compositor's normalised space (y up). */
export const toNormalised = (point: Point, frame: FrameSize): Point => ({
  x: (point.x / frame.width) * 2 - 1,
  y: 1 - (point.y / frame.height) * 2,
});

/** Normalised space back to project pixels. */
export const toPixels = (point: Point, frame: FrameSize): Point => ({
  x: ((point.x + 1) / 2) * frame.width,
  y: ((1 - point.y) / 2) * frame.height,
});

interface Quad {
  /** Unit-quad corner (0,0), in normalised space. */
  origin: Point;
  /** The clip's own width axis, and its length in normalised units. */
  u: Point;
  width: number;
  /** The clip's own height axis, and its length. */
  v: Point;
  height: number;
}

/** The clip's quad, built exactly as Compositor.renderLayer builds it. */
function quadOf(transform: ResolvedTransform, frame: FrameSize): Quad {
  const centerX = (transform.position.x / frame.width) * 2;
  const centerY = -(transform.position.y / frame.height) * 2;

  const radians = -(transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const sx = transform.scale.x * 2;
  const sy = transform.scale.y * 2;
  const ax = -transform.anchorPoint.x * sx;
  const ay = -transform.anchorPoint.y * sy;

  return {
    origin: {
      x: centerX + cos * ax - sin * ay,
      y: centerY + sin * ax + cos * ay,
    },
    u: { x: cos, y: sin },
    width: sx,
    v: { x: -sin, y: cos },
    height: sy,
  };
}

const cornerOf = (quad: Quad, u: number, v: number): Point =>
  add(quad.origin, add(times(quad.u, quad.width * u), times(quad.v, quad.height * v)));

/**
 * The clip's four corners in project pixels: bottom-left, bottom-right,
 * top-right, top-left of the clip's own frame, wherever they now appear.
 */
export function quadCorners(transform: ResolvedTransform, frame: FrameSize): Point[] {
  const quad = quadOf(transform, frame);
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => toPixels(cornerOf(quad, u, v), frame));
}

/** Screen positions of every grip, for drawing them. */
export function handlePositions(transform: ResolvedTransform, frame: FrameSize): Record<Handle, Point> {
  const quad = quadOf(transform, frame);
  const at = (u: number, v: number): Point => toPixels(cornerOf(quad, u, v), frame);
  return {
    bottomLeft: at(0, 0),
    bottomRight: at(1, 0),
    topRight: at(1, 1),
    topLeft: at(0, 1),
    left: at(0, 0.5),
    right: at(1, 0.5),
    bottom: at(0.5, 0),
    top: at(0.5, 1),
  };
}

/** Where the anchor sits, in project pixels: the pivot the clip turns about. */
export function anchorPosition(transform: ResolvedTransform, frame: FrameSize): Point {
  const quad = quadOf(transform, frame);
  return toPixels(cornerOf(quad, transform.anchorPoint.x, transform.anchorPoint.y), frame);
}

/** Dragging the picture itself: the whole clip follows the pointer. */
export function movedPosition(start: ResolvedTransform, deltaPx: Point): Vector2D {
  return { x: start.position.x + deltaPx.x, y: start.position.y + deltaPx.y };
}

/** Is `pointerPx` on the clip? What decides whether a drag starts. */
export function containsPoint(transform: ResolvedTransform, pointerPx: Point, frame: FrameSize): boolean {
  const quad = quadOf(transform, frame);
  const relative = subtract(toNormalised(pointerPx, frame), quad.origin);
  const along = dot(relative, quad.u);
  const across = dot(relative, quad.v);
  return along >= 0 && along <= quad.width && across >= 0 && across <= quad.height;
}

/** The corner or edge midpoint that stays put while `handle` is dragged. */
function fixedCorner(handle: Handle, quad: Quad): Point {
  switch (handle) {
    case 'bottomLeft':
      return cornerOf(quad, 1, 1);
    case 'bottomRight':
      return cornerOf(quad, 0, 1);
    case 'topRight':
      return cornerOf(quad, 0, 0);
    case 'topLeft':
      return cornerOf(quad, 1, 0);
    case 'left':
      return cornerOf(quad, 1, 0.5);
    case 'right':
      return cornerOf(quad, 0, 0.5);
    case 'bottom':
      return cornerOf(quad, 0.5, 1);
    case 'top':
    default:
      return cornerOf(quad, 0.5, 0);
  }
}

export interface ScaleResult {
  scale: Vector2D;
  position: Vector2D;
}

/**
 * Scale from a grip, keeping the opposite corner or edge where it is.
 *
 * That is what the eye expects: the side you are not holding does not wander.
 * Corners keep the clip's proportions unless `free` is asked for; edges only
 * ever change the axis they belong to.
 */
export function scaleFromHandle(
  start: ResolvedTransform,
  handle: Handle,
  pointerPx: Point,
  frame: FrameSize,
  options: { free?: boolean } = {},
): ScaleResult {
  const quad = quadOf(start, frame);
  const fixed = fixedCorner(handle, quad);
  const toPointer = subtract(toNormalised(pointerPx, frame), fixed);

  const horizontal = handle !== 'top' && handle !== 'bottom';
  const vertical = handle !== 'left' && handle !== 'right';

  let width = horizontal ? Math.abs(dot(toPointer, quad.u)) : quad.width;
  let height = vertical ? Math.abs(dot(toPointer, quad.v)) : quad.height;

  if (horizontal && vertical && !options.free) {
    // One factor for both axes - the larger, so the clip follows the pointer
    // rather than lagging behind on its shorter side.
    const factor = Math.max(width / Math.max(quad.width, 1e-9), height / Math.max(quad.height, 1e-9));
    width = quad.width * factor;
    height = quad.height * factor;
  }

  width = Math.max(MIN_SCALE * 2, width);
  height = Math.max(MIN_SCALE * 2, height);

  // Which way the clip extends from the point that is staying put. For an edge
  // grip the fixed point is a mid-edge, so on that axis the sign is zero and
  // the clip stays centred on it.
  const centreNow = cornerOf(quad, 0.5, 0.5);
  const fromFixed = subtract(centreNow, fixed);
  const sign = (value: number): number => (Math.abs(value) < 1e-9 ? 0 : Math.sign(value));
  const alongU = sign(dot(fromFixed, quad.u));
  const alongV = sign(dot(fromFixed, quad.v));

  const centre = add(fixed, add(times(quad.u, (alongU * width) / 2), times(quad.v, (alongV * height) / 2)));
  const origin = subtract(centre, add(times(quad.u, width / 2), times(quad.v, height / 2)));
  const anchor = add(
    origin,
    add(times(quad.u, width * start.anchorPoint.x), times(quad.v, height * start.anchorPoint.y)),
  );

  return {
    scale: { x: width / 2, y: height / 2 },
    position: {
      x: (anchor.x * frame.width) / 2,
      y: -(anchor.y * frame.height) / 2,
    },
  };
}

/** The pointer's angle around the anchor, in degrees, for starting a rotation. */
export function angleAround(start: ResolvedTransform, pointerPx: Point, frame: FrameSize): number {
  const quad = quadOf(start, frame);
  const pivot = cornerOf(quad, start.anchorPoint.x, start.anchorPoint.y);
  const toPointer = subtract(toNormalised(pointerPx, frame), pivot);
  // Negated y: the result is read as a clockwise screen angle, which is the
  // direction the rotation field counts in.
  return (Math.atan2(-toPointer.y, toPointer.x) * 180) / Math.PI;
}

/**
 * Rotation in degrees from the pointer's angle around the anchor.
 *
 * `snapDegrees` holds it to multiples of that - how a clip gets put back to
 * straight, or turned exactly a quarter turn.
 */
export function rotationFromPointer(
  start: ResolvedTransform,
  pointerPx: Point,
  frame: FrameSize,
  options: { grabAngle: number; snapDegrees?: number },
): number {
  const quad = quadOf(start, frame);
  const pivot = cornerOf(quad, start.anchorPoint.x, start.anchorPoint.y);
  const toPointer = subtract(toNormalised(pointerPx, frame), pivot);
  if (length(toPointer) < 1e-9) return start.rotation;

  const rotation = start.rotation + (angleAround(start, pointerPx, frame) - options.grabAngle);
  if (!options.snapDegrees) return rotation;
  return Math.round(rotation / options.snapDegrees) * options.snapDegrees;
}

/** Normalised direction of the clip's own width axis; used to aim the cursors. */
export function widthAxis(transform: ResolvedTransform, frame: FrameSize): Point {
  const [bottomLeft, bottomRight] = quadCorners(transform, frame);
  return normalise(subtract(bottomRight, bottomLeft));
}
