import type { AnimationCel, DrawnAnimation, OnionSkin, Stroke } from '@shared/types';
import { celAt, onionAround } from './model';
import { applyPlace, chainKey, chainOf, isMoved, placeOf } from './motion';

/**
 * Drawing an animation's strokes onto a canvas.
 *
 * Strokes are stored in fractions of the frame, so the same drawing rasterizes
 * at any size: the viewer draws it small while playing, the export draws it at
 * project resolution, and neither needs its own copy of the data.
 *
 * Width follows pressure, so a stroke tapers as a brush does. It is drawn as a
 * run of round-capped segments rather than one path, because one path can only
 * have one width - this is what gives a line its weight.
 */

export interface RasterOptions {
  width: number;
  height: number;
  /** The onion skin to draw under the current drawing; left out for an export. */
  onion?: OnionSkin;
  /** A canvas to draw into again, to avoid making one per frame. */
  into?: HTMLCanvasElement;
  /**
   * The TIMELINE frame, for layers that are moved about (cut-out animation).
   * Left out, nothing moves - which is right for a layer with no motion on it.
   */
  frame?: number;
}

/** A stroke's width in pixels at a given point's pressure. */
function widthAt(stroke: Stroke, pressure: number, shorter: number): number {
  const base = stroke.size * shorter;
  // A pencil answers to pressure; a marker lays down an even line, as one does.
  const factor = stroke.brush === 'marker' ? 1 : 0.35 + 0.65 * Math.min(1, Math.max(0, pressure));
  return Math.max(0.5, base * factor);
}

/**
 * One stroke onto a context whose units are pixels.
 *
 * An eraser takes away what is under it on the same layer, which is what
 * `destination-out` does: it is a real eraser, not white paint, so what is on
 * the layers below still shows through the hole.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, opacity = 1): void {
  const points = stroke.points;
  if (points.length < 3) return;
  const shorter = Math.min(width, height);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, stroke.opacity * opacity));
  ctx.globalCompositeOperation = stroke.brush === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // A tap - one point - is a dot, and must be: a dab of the brush leaves a mark.
  if (points.length === 3) {
    const radius = widthAt(stroke, points[2], shorter) / 2;
    ctx.beginPath();
    ctx.arc(points[0] * width, points[1] * height, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let index = 3; index < points.length; index += 3) {
    const fromX = points[index - 3] * width;
    const fromY = points[index - 2] * height;
    const toX = points[index] * width;
    const toY = points[index + 1] * height;
    // The segment's width is the mean of its ends', so width changes evenly
    // along the stroke instead of stepping at each point.
    ctx.lineWidth = (widthAt(stroke, points[index - 1], shorter) + widthAt(stroke, points[index + 2], shorter)) / 2;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
  }
  ctx.restore();
}

/** One drawing's strokes, in order, onto a context. */
export function drawCel(ctx: CanvasRenderingContext2D, cel: AnimationCel, width: number, height: number, opacity = 1): void {
  for (const stroke of cel.strokes) drawStroke(ctx, stroke, width, height, opacity);
}

/**
 * The picture of an animation at an exposure.
 *
 * Layers are drawn bottom first, each onto a canvas of its own so that an
 * eraser on one layer cannot cut a hole through the layers below it - the
 * whole point of having layers. A layer with nothing on it costs nothing.
 *
 * Onion skin is drawn UNDER the current drawing and only when asked for, so
 * an export never carries it: it is an aid to the hand, not part of the film.
 */
export function rasterizeAnimation(anim: DrawnAnimation, exposure: number, options: RasterOptions): HTMLCanvasElement {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const canvas = options.into ?? document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, width, height);

  let scratch: HTMLCanvasElement | null = null;
  for (const layer of anim.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const cel = celAt(layer, exposure);
    const ghosts = options.onion ? onionAround(layer, exposure, options.onion) : [];
    if (!cel && ghosts.length === 0) continue;

    // Each layer on its own canvas, so `destination-out` stays inside it.
    scratch ??= document.createElement('canvas');
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    const layerCtx = scratch.getContext('2d');
    if (!layerCtx) continue;
    layerCtx.clearRect(0, 0, width, height);

    for (const ghost of ghosts) drawCel(layerCtx, ghost.cel, width, height, ghost.opacity);
    if (cel) drawCel(layerCtx, cel, width, height);

    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity));
    // Cut-out animation: the layer moved as a whole, with every layer it hangs
    // from applied first - furthest ancestor down - so a hand follows its arm.
    if (options.frame !== undefined) {
      for (const link of chainOf(anim.layers, layer)) {
        const place = placeOf(link.motion, options.frame);
        if (isMoved(place)) applyPlace(ctx, place, width, height);
      }
    }
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
  return canvas;
}

/**
 * What the picture at an exposure depends on, as a short string.
 *
 * This is what makes playback cost nothing: while a drawing is held, the key
 * does not change, so the texture already uploaded is used again. It lists the
 * drawings actually shown - the current one and any ghosts - rather than the
 * whole animation, so drawing on exposure 40 does not force exposure 1 to be
 * drawn again.
 */
export function rasterKey(anim: DrawnAnimation, exposure: number, width: number, height: number, onion?: OnionSkin, frame?: number): string {
  const parts: string[] = [`${width}x${height}`];
  for (const layer of anim.layers) {
    if (!layer.visible || layer.opacity <= 0) {
      parts.push(`${layer.id}:off`);
      continue;
    }
    const cel = celAt(layer, exposure);
    const ghosts = onion ? onionAround(layer, exposure, onion) : [];
    // The motion too: a layer that is moving changes picture every frame even
    // though its drawing is held, so the key has to say so or it would never
    // be drawn again.
    const moved = frame === undefined ? '' : chainKey(anim.layers, layer, frame);
    parts.push(
      `${layer.id}@${layer.opacity.toFixed(3)}:${cel ? `${cel.id}/${cel.strokes.length}` : '-'}` +
        (ghosts.length ? `+${ghosts.map((ghost) => `${ghost.cel.id}/${ghost.cel.strokes.length}@${ghost.opacity.toFixed(2)}`).join(',')}` : '') +
        (moved ? `~${moved}` : ''),
    );
  }
  return parts.join('|');
}
