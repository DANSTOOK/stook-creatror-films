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

/**
 * A layer that covers only part of the frame and turns about a point of its
 * own: a title, whose picture is its text and whose pivot is the text's
 * centre (text/geometry). Both in project pixels, before any transform.
 */
export interface LayerShape {
  rect: { x: number; y: number; width: number; height: number };
  pivot: Point;
}

/** Where the layer's anchor sits in its full-frame quad, 0..1 with y up. */
const anchorOf = (transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Point =>
  layer ? { x: layer.pivot.x / frame.width, y: 1 - layer.pivot.y / frame.height } : transform.anchorPoint;

/**
 * The clip's quad, built exactly as Compositor.renderLayer builds it: the
 * whole frame, or with a layer shape, the part of it the layer covers.
 */
function quadOf(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Quad {
  const full = frameQuadOf(transform, frame, layer);
  if (!layer) return full;
  const u0 = layer.rect.x / frame.width;
  const v0 = 1 - (layer.rect.y + layer.rect.height) / frame.height;
  return {
    origin: cornerOf(full, u0, v0),
    u: full.u,
    width: (full.width * layer.rect.width) / frame.width,
    v: full.v,
    height: (full.height * layer.rect.height) / frame.height,
  };
}

/** The pivot, in normalised space: where the anchor lands. */
function pivotOf(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Point {
  const anchor = anchorOf(transform, frame, layer);
  return cornerOf(frameQuadOf(transform, frame, layer), anchor.x, anchor.y);
}

function frameQuadOf(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Quad {
  const anchorPoint = anchorOf(transform, frame, layer);
  // A titled layer's pivot is where the frame's centre is for any other.
  const centerX = (layer ? anchorPoint.x * 2 - 1 : 0) + (transform.position.x / frame.width) * 2;
  const centerY = (layer ? anchorPoint.y * 2 - 1 : 0) - (transform.position.y / frame.height) * 2;

  const radians = -(transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const sx = transform.scale.x * 2;
  const sy = transform.scale.y * 2;
  const ax = -anchorPoint.x * sx;
  const ay = -anchorPoint.y * sy;

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
export function quadCorners(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Point[] {
  const quad = quadOf(transform, frame, layer);
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => toPixels(cornerOf(quad, u, v), frame));
}

/** Screen positions of every grip, for drawing them. */
export function handlePositions(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Record<Handle, Point> {
  const quad = quadOf(transform, frame, layer);
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
export function anchorPosition(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): Point {
  return toPixels(pivotOf(transform, frame, layer), frame);
}

/** Dragging the picture itself: the whole clip follows the pointer. */
export function movedPosition(start: ResolvedTransform, deltaPx: Point): Vector2D {
  return { x: start.position.x + deltaPx.x, y: start.position.y + deltaPx.y };
}

/** Where a dragged picture was pulled into line, for drawing the guides. */
export interface SnapResult {
  position: Vector2D;
  /** Snapped horizontally: the guide runs down the frame. */
  vertical: boolean;
  /** Snapped vertically: the guide runs across it. */
  horizontal: boolean;
}

/**
 * Pull a moved picture onto the lines that matter.
 *
 * Centring a shot by hand is a game of one pixel at a time, and every
 * editor answers it the same way: the drag sticks to the middle of the
 * frame and to the frame's own edges, and says so with a guide. The
 * candidates are the centre (position 0) and the offsets that put the
 * picture's edges on the frame's, so a clip can be pushed flush left or
 * right without measuring.
 *
 * `toleranceP0x` is in project pixels - the same units as the position -
 * so the stickiness is the same however the viewer is scaled.
 */
export function snappedPosition(
  position: Vector2D,
  transform: ResolvedTransform,
  frame: FrameSize,
  tolerancePx: number,
): SnapResult {
  if (tolerancePx <= 0) return { position, vertical: false, horizontal: false };

  // Half the gap between the picture and the frame, which is where an edge
  // of the picture meets the matching edge of the frame.
  const halfSpareX = Math.abs((frame.width * (1 - Math.abs(transform.scale.x))) / 2);
  const halfSpareY = Math.abs((frame.height * (1 - Math.abs(transform.scale.y))) / 2);

  const nearest = (value: number, candidates: readonly number[]): number | null => {
    let best: number | null = null;
    for (const candidate of candidates) {
      const distance = Math.abs(value - candidate);
      if (distance <= tolerancePx && (best === null || distance < Math.abs(value - best))) {
        best = candidate;
      }
    }
    return best;
  };

  const x = nearest(position.x, [0, -halfSpareX, halfSpareX]);
  const y = nearest(position.y, [0, -halfSpareY, halfSpareY]);

  return {
    position: { x: x ?? position.x, y: y ?? position.y },
    vertical: x !== null,
    horizontal: y !== null,
  };
}

/** Is `pointerPx` on the clip? What decides whether a drag starts. */
export function containsPoint(transform: ResolvedTransform, pointerPx: Point, frame: FrameSize, layer?: LayerShape): boolean {
  const quad = quadOf(transform, frame, layer);
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
  layer?: LayerShape,
): ScaleResult {
  const quad = quadOf(start, frame, layer);
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

  if (layer) {
    // The pivot keeps its place in the text's box, and the position is where
    // the pivot now is, measured from where it sits unmoved.
    const anchorPoint = anchorOf(start, frame, layer);
    const u0 = layer.rect.x / frame.width;
    const v0 = 1 - (layer.rect.y + layer.rect.height) / frame.height;
    const du = layer.rect.width / frame.width;
    const dv = layer.rect.height / frame.height;
    const inBoxU = (anchorPoint.x - u0) / du;
    const inBoxV = (anchorPoint.y - v0) / dv;
    const pivot = add(origin, add(times(quad.u, width * inBoxU), times(quad.v, height * inBoxV)));
    return {
      scale: { x: width / 2 / du, y: height / 2 / dv },
      position: {
        x: ((pivot.x - (anchorPoint.x * 2 - 1)) * frame.width) / 2,
        y: -((pivot.y - (anchorPoint.y * 2 - 1)) * frame.height) / 2,
      },
    };
  }

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
export function angleAround(start: ResolvedTransform, pointerPx: Point, frame: FrameSize, layer?: LayerShape): number {
  const pivot = pivotOf(start, frame, layer);
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
  layer?: LayerShape,
): number {
  const pivot = pivotOf(start, frame, layer);
  const toPointer = subtract(toNormalised(pointerPx, frame), pivot);
  if (length(toPointer) < 1e-9) return start.rotation;

  const rotation = start.rotation + (angleAround(start, pointerPx, frame, layer) - options.grabAngle);
  if (!options.snapDegrees) return rotation;
  return Math.round(rotation / options.snapDegrees) * options.snapDegrees;
}

/** Normalised direction of the clip's own width axis; used to aim the cursors. */
export function widthAxis(transform: ResolvedTransform, frame: FrameSize): Point {
  const [bottomLeft, bottomRight] = quadCorners(transform, frame);
  return normalise(subtract(bottomRight, bottomLeft));
}

/**
 * Untransformed project pixels of a layer to where they are drawn, as an
 * affine map [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) -
 * the CSS matrix() order. The viewer's text editor sits on a title with it,
 * so its letters land on the drawn ones.
 */
export function layerToPixels(transform: ResolvedTransform, frame: FrameSize, layer?: LayerShape): [number, number, number, number, number, number] {
  const full = frameQuadOf(transform, frame, layer);
  const at = (x: number, y: number): Point => toPixels(cornerOf(full, x / frame.width, 1 - y / frame.height), frame);
  const origin = at(0, 0);
  const xAxis = at(1, 0);
  const yAxis = at(0, 1);
  return [xAxis.x - origin.x, xAxis.y - origin.y, yAxis.x - origin.x, yAxis.y - origin.y, origin.x, origin.y];
}

/** Where a dragged title was pulled into line, for drawing the guides. */
export interface TitleSnapResult extends SnapResult {
  /** An edge landed on the title-safe area's. */
  safe: boolean;
}

/**
 * Pull a moved title onto the lines a title lives by: its centre onto the
 * frame's centre lines, and its edges onto the title-safe area's (TITLE_SAFE
 * of the frame each way, the guide Final Cut and Premiere draw).
 */
export function snappedTitlePosition(
  position: Vector2D,
  start: ResolvedTransform,
  frame: FrameSize,
  layer: LayerShape,
  tolerancePx: number,
  titleSafe: number,
): TitleSnapResult {
  if (tolerancePx <= 0) return { position, vertical: false, horizontal: false, safe: false };
  const corners = quadCorners(start, frame, layer);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const dx = position.x - start.position.x;
  const dy = position.y - start.position.y;
  const box = { left: Math.min(...xs) + dx, right: Math.max(...xs) + dx, top: Math.min(...ys) + dy, bottom: Math.max(...ys) + dy };
  const marginX = (frame.width * (1 - titleSafe)) / 2;
  const marginY = (frame.height * (1 - titleSafe)) / 2;

  // Each candidate is how far the title has to move to sit on a line.
  const pick = (candidates: Array<{ shift: number; centre: boolean }>): { shift: number; centre: boolean } | null => {
    let best: { shift: number; centre: boolean } | null = null;
    for (const candidate of candidates) {
      if (Math.abs(candidate.shift) <= tolerancePx && (!best || Math.abs(candidate.shift) < Math.abs(best.shift))) best = candidate;
    }
    return best;
  };
  const x = pick([
    { shift: frame.width / 2 - (box.left + box.right) / 2, centre: true },
    { shift: marginX - box.left, centre: false },
    { shift: frame.width - marginX - box.right, centre: false },
  ]);
  const y = pick([
    { shift: frame.height / 2 - (box.top + box.bottom) / 2, centre: true },
    { shift: marginY - box.top, centre: false },
    { shift: frame.height - marginY - box.bottom, centre: false },
  ]);
  return {
    position: { x: position.x + (x?.shift ?? 0), y: position.y + (y?.shift ?? 0) },
    vertical: x?.centre === true,
    horizontal: y?.centre === true,
    safe: (x !== null && !x.centre) || (y !== null && !y.centre),
  };
}
