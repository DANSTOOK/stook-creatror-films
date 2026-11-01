import type { AnimationLayer, LayerMotion, Vector2D } from '@shared/types';
import { evaluateNumber, evaluateVector } from '@renderer/engine/KeyframeEvaluator';

/**
 * Cut-out animation: a drawing moved as a whole instead of redrawn.
 *
 * This is the cheapest real power in the whole module, because none of it is
 * new. The keyframes are the app's own `Keyframe<T>`, with the same nine
 * easings and the same curve editor a title uses; all that is added here is
 * where a layer sits at a frame, and the rule for a layer that hangs from
 * another.
 *
 * Everything is in fractions of the frame, as strokes are, so a rig holds at
 * any project size.
 */

export const NO_PLACE: Place = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0.5, pivotY: 0.5 };

/** Where a layer sits at one frame, flat, as a draw call wants it. */
export interface Place {
  /** Offset from where the drawing was drawn, in fractions of the frame. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise, as the inspector shows it. */
  rotation: number;
  pivotX: number;
  pivotY: number;
}

const CENTRE: Vector2D = { x: 0, y: 0 };
const UNIT: Vector2D = { x: 1, y: 1 };

/** A layer's own motion at a frame, before its parent's is taken into account. */
export function placeOf(motion: LayerMotion | undefined, frame: number): Place {
  if (!motion) return NO_PLACE;
  const position = motion.position?.length ? evaluateVector(motion.position, frame, CENTRE) : CENTRE;
  const scale = motion.scale?.length ? evaluateVector(motion.scale, frame, UNIT) : UNIT;
  return {
    x: position.x,
    y: position.y,
    scaleX: scale.x,
    scaleY: scale.y,
    rotation: motion.rotation?.length ? evaluateNumber(motion.rotation, frame, 0) : 0,
    pivotX: motion.pivot?.x ?? 0.5,
    pivotY: motion.pivot?.y ?? 0.5,
  };
}

/** Whether a layer is moved at all, so one that is not costs nothing to draw. */
export const isMoved = (place: Place): boolean =>
  place.x !== 0 || place.y !== 0 || place.scaleX !== 1 || place.scaleY !== 1 || place.rotation !== 0;

/**
 * The chain of layers a layer hangs from, from the FURTHEST ancestor down to
 * the layer itself, so applying them in order works like a joint.
 *
 * A parent that is missing, is the layer itself, or would close a loop is
 * dropped: a rig with a cycle in it would otherwise hang the renderer, and a
 * drawing that cannot be placed is worse than one placed plainly.
 */
export function chainOf(layers: AnimationLayer[], layer: AnimationLayer): AnimationLayer[] {
  const byId = new Map(layers.map((candidate) => [candidate.id, candidate]));
  const chain: AnimationLayer[] = [layer];
  const seen = new Set([layer.id]);
  let at = layer;
  // No rig is deeper than the layers it has, so this cannot run away even if
  // the guard below were wrong.
  for (let depth = 0; depth < layers.length; depth += 1) {
    const parentId = at.parentId;
    if (!parentId || seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent);
    at = parent;
  }
  return chain;
}

/**
 * Put a layer's place onto a canvas context, pivot and all.
 *
 * The order is the usual one and it matters: move to the pivot, turn and
 * scale there, then move back. Scaling before moving to the pivot would move
 * the drawing as well as size it.
 */
export function applyPlace(ctx: CanvasRenderingContext2D, place: Place, width: number, height: number): void {
  const pivotX = place.pivotX * width;
  const pivotY = place.pivotY * height;
  ctx.translate(pivotX + place.x * width, pivotY + place.y * height);
  if (place.rotation !== 0) ctx.rotate((place.rotation * Math.PI) / 180);
  if (place.scaleX !== 1 || place.scaleY !== 1) ctx.scale(place.scaleX, place.scaleY);
  ctx.translate(-pivotX, -pivotY);
}

/** A layer's place with every ancestor's applied before it, as a key can describe. */
export function chainKey(layers: AnimationLayer[], layer: AnimationLayer, frame: number): string {
  const chain = chainOf(layers, layer);
  if (chain.length === 1 && !layer.motion) return '';
  return chain
    .map((link) => {
      const place = placeOf(link.motion, frame);
      return `${link.id}:${place.x.toFixed(4)},${place.y.toFixed(4)},${place.scaleX.toFixed(4)},${place.scaleY.toFixed(4)},${place.rotation.toFixed(2)},${place.pivotX.toFixed(3)},${place.pivotY.toFixed(3)}`;
    })
    .join('>');
}
