import type { AnimationLayer, Clip, DrawnAnimation, Stroke } from '@shared/types';
import { celAt, exposureCount, stepOf } from './model';
import { placeOf } from './motion';

/**
 * Lottie out.
 *
 * This is the payment for a decision taken on the first day: strokes were
 * stored as DATA and not as pixels. A drawing kept as pixels could only ever
 * be exported as pixels; kept as points, it becomes a shape layer that After
 * Effects, Figma, a web page or a phone can all read and scale.
 *
 * The two models line up closely, which is why this is a translation and not
 * an invention:
 *
 *  - Their keyframes are `t` the frame, `s` the value, `h` to hold, and `i`/`o`
 *    as bézier handles - the same shape as this app's own, hold included.
 *  - Their shape layer (`ty: 4`) carries groups of a path, a stroke style and
 *    a transform, which is exactly a drawn stroke.
 *  - Shapes within a group are drawn in REVERSE order, and a style applies to
 *    the shapes before it. Both are honoured below; getting either wrong is
 *    the usual reason a Lottie file opens looking inside out.
 *
 * What is NOT exported, said plainly rather than fudged: the eraser. Lottie
 * has no "take away what is under this on the same layer" that survives a
 * round trip through every player, so an erased stroke is left out and the
 * caller is told how many were dropped.
 */

export interface LottieResult {
  json: string;
  /** Strokes left out because they cannot be expressed; the panel says so. */
  dropped: number;
  layers: number;
}

/** #rrggbb to Lottie's 0..1 triple. */
export function toRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [1, 1, 1];
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * A stroke's points as a Lottie path.
 *
 * Lottie wants vertices with in and out tangents. Straight segments are used -
 * `i` and `o` both zero - because that is exactly what this app draws: a run
 * of short straight segments with round caps. Inventing curves here would
 * make the export differ from what is on screen.
 *
 * Coordinates go from fractions of the frame to Lottie's pixels.
 */
export function toPath(stroke: Stroke, width: number, height: number): { i: number[][]; o: number[][]; v: number[][]; c: boolean } {
  const vertices: number[][] = [];
  for (let index = 0; index < stroke.points.length; index += 3) {
    vertices.push([stroke.points[index] * width, stroke.points[index + 1] * height]);
  }
  const zeroes = vertices.map(() => [0, 0]);
  // Closed when it ends where it began, which is what a rectangle or an
  // ellipse from the shape tool does.
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  const closed = vertices.length > 2 && Math.abs(first[0] - last[0]) < 0.01 && Math.abs(first[1] - last[1]) < 0.01;
  return { i: zeroes, o: zeroes, v: vertices, c: closed };
}

/** One stroke as a Lottie group: the path, then the style that paints it. */
function strokeGroup(stroke: Stroke, width: number, height: number): object {
  const shorter = Math.min(width, height);
  return {
    ty: 'gr',
    nm: stroke.id,
    it: [
      { ty: 'sh', ind: 0, ks: { a: 0, k: toPath(stroke, width, height) } },
      {
        // The style comes AFTER the path it paints: Lottie applies a style to
        // the shapes before it in the group.
        ty: 'st',
        c: { a: 0, k: [...toRgb(stroke.color), 1] },
        o: { a: 0, k: Math.round(stroke.opacity * 100) },
        w: { a: 0, k: Math.max(0.5, stroke.size * shorter) },
        lc: 2,
        lj: 2,
      },
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ],
  };
}

/**
 * A drawing layer as a Lottie shape layer.
 *
 * Frame-by-frame drawing is expressed the way a camera expresses it: every
 * exposure is its own shape layer, shown for exactly the frames that drawing
 * is held. A player then shows one at a time, which is the animation.
 */
function celLayers(
  layer: AnimationLayer,
  anim: DrawnAnimation,
  clip: Pick<Clip, 'durationFrames'>,
  width: number,
  height: number,
  index: { value: number },
): { layers: object[]; dropped: number } {
  const step = stepOf(anim);
  const total = exposureCount(anim, clip);
  const layers: object[] = [];
  let dropped = 0;

  for (const cel of layer.cels) {
    if (cel.at >= total) continue;
    const drawable = cel.strokes.filter((one) => one.brush !== 'eraser');
    dropped += cel.strokes.length - drawable.length;
    if (drawable.length === 0) continue;

    // Shown from this drawing's first frame until the next drawing begins.
    const nextAt = layer.cels.find((other) => other.at > cel.at)?.at ?? total;
    const inPoint = cel.at * step;
    const outPoint = Math.min(nextAt * step, Math.max(1, Math.floor(clip.durationFrames)));
    // A drawing moved as a whole is placed at the frame it appears on; a
    // moving layer is sampled per drawing rather than animated, which is
    // honest about what a per-cel layer can carry.
    const place = placeOf(layer.motion, inPoint);

    layers.push({
      ddd: 0,
      ind: (index.value += 1),
      ty: 4,
      nm: `${layer.name} ${cel.at + 1}`,
      sr: 1,
      ks: {
        o: { a: 0, k: Math.round(layer.opacity * 100) },
        r: { a: 0, k: place.rotation },
        p: { a: 0, k: [place.x * width + width / 2, place.y * height + height / 2] },
        a: { a: 0, k: [width / 2, height / 2] },
        s: { a: 0, k: [place.scaleX * 100, place.scaleY * 100] },
      },
      ao: 0,
      // Reverse: Lottie draws a group's shapes back to front, so the stroke
      // drawn first must come last to end up underneath.
      shapes: drawable.map((one) => strokeGroup(one, width, height)).reverse(),
      ip: inPoint,
      op: outPoint,
      st: 0,
      bm: 0,
    });
  }
  return { layers, dropped };
}

/** The whole animation as a Lottie document. */
export function toLottie(anim: DrawnAnimation, clip: Pick<Clip, 'durationFrames' | 'name'>, width: number, height: number, fps: number): LottieResult {
  const index = { value: 0 };
  const out: object[] = [];
  let dropped = 0;
  // Bottom layer first here, because Lottie draws its layer list TOP first -
  // so the list is reversed at the end and the bottom one ends up last.
  for (const layer of anim.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const made = celLayers(layer, anim, clip, width, height, index);
    out.push(...made.layers);
    dropped += made.dropped;
  }

  const document = {
    v: '5.7.4',
    fr: fps,
    ip: 0,
    op: Math.max(1, Math.floor(clip.durationFrames)),
    w: width,
    h: height,
    nm: clip.name,
    ddd: 0,
    assets: [],
    layers: out.reverse(),
  };
  return { json: JSON.stringify(document), dropped, layers: out.length };
}

/** Whether there is anything to export, for enabling the button. */
export function hasDrawings(anim: DrawnAnimation | undefined): boolean {
  if (!anim) return false;
  return anim.layers.some((layer) => layer.cels.some((cel) => cel.strokes.some((one) => one.brush !== 'eraser')));
}

/** The exposure a layer shows at a frame, re-exported so callers need one import. */
export { celAt };
