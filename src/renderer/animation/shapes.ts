import type { Stroke } from '@shared/types';
import { newId } from './model';

/**
 * Shapes drawn by dragging, rather than freehand.
 *
 * OpenToonz's geometric tool offers rectangle, ellipse, polyline, arc and
 * polygon; these are the four of those a video editor's animation panel
 * actually needs, and each one is turned into an ordinary STROKE. That is the
 * whole trick: a shape is not a new kind of object with its own storage, its
 * own renderer and its own file format - it is a stroke whose points were
 * worked out instead of felt. Everything that already works on a stroke - the
 * eraser, undo, onion skin, layer motion, saving, the Lottie export to come -
 * works on a shape the day it is added.
 *
 * Every point carries full pressure, so a shape draws at an even width.
 */

export type ShapeKind = 'line' | 'rectangle' | 'ellipse' | 'polygon';

export const SHAPE_KINDS: readonly ShapeKind[] = ['line', 'rectangle', 'ellipse', 'polygon'];

/** How many segments an ellipse is drawn with: smooth at any size we raster at. */
const ELLIPSE_STEPS = 64;

export const MIN_SIDES = 3;
export const MAX_SIDES = 12;

export interface ShapeOptions {
  kind: ShapeKind;
  /** Where the drag began and where it is now, in fractions of the frame. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Sides of a polygon, 3 to 12. Ignored by the others. */
  sides?: number;
  /**
   * Hold Shift: a square, a circle, or a line at a right angle. Measured from
   * the longer side so the shape follows the hand rather than shrinking.
   */
  even?: boolean;
}

/** The points of a shape, flat as a stroke stores them: x, y, pressure. */
export function shapePoints(options: ShapeOptions): number[] {
  const { kind } = options;
  const { from, to } = evened(options);

  if (kind === 'line') return [from.x, from.y, 1, to.x, to.y, 1];

  if (kind === 'rectangle') {
    // Closed: back to the first corner, or the last side would be missing.
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    return [left, top, 1, right, top, 1, right, bottom, 1, left, bottom, 1, left, top, 1];
  }

  // An ellipse and a polygon are both drawn round the middle of the drag, out
  // to its corner - which is how a shape tool behaves everywhere.
  const centreX = (from.x + to.x) / 2;
  const centreY = (from.y + to.y) / 2;
  const radiusX = Math.abs(to.x - from.x) / 2;
  const radiusY = Math.abs(to.y - from.y) / 2;

  if (kind === 'ellipse') {
    const points: number[] = [];
    for (let step = 0; step <= ELLIPSE_STEPS; step += 1) {
      const angle = (step / ELLIPSE_STEPS) * Math.PI * 2;
      points.push(centreX + Math.cos(angle) * radiusX, centreY + Math.sin(angle) * radiusY, 1);
    }
    return points;
  }

  const sides = Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(options.sides ?? 5)));
  const points: number[] = [];
  for (let step = 0; step <= sides; step += 1) {
    // Point upwards, which is how a polygon is expected to sit.
    const angle = (step / sides) * Math.PI * 2 - Math.PI / 2;
    points.push(centreX + Math.cos(angle) * radiusX, centreY + Math.sin(angle) * radiusY, 1);
  }
  return points;
}

/** Shift: square it off, or hold a line to the nearest right angle. */
function evened({ kind, from, to, even }: ShapeOptions): { from: { x: number; y: number }; to: { x: number; y: number } } {
  if (!even) return { from, to };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (kind === 'line') {
    // Whichever way the hand went further wins; the other axis is flattened.
    return Math.abs(dx) >= Math.abs(dy) ? { from, to: { x: to.x, y: from.y } } : { from, to: { x: from.x, y: to.y } };
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { from, to: { x: from.x + Math.sign(dx || 1) * size, y: from.y + Math.sign(dy || 1) * size } };
}

/** A whole stroke for a shape, ready to go into a drawing. */
export function shapeStroke(options: ShapeOptions, brush: Omit<Stroke, 'id' | 'points'>): Stroke {
  return { ...brush, id: newId('shape'), points: shapePoints(options) };
}

/** Whether a drag is big enough to be a shape rather than a slip of the hand. */
export const isRealDrag = (from: { x: number; y: number }, to: { x: number; y: number }): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) > 0.004;
