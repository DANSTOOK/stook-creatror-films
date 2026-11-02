import type { AnimationCel, AnimationLayer, Easing, Stroke } from '@shared/types';
import { easeProgress } from '@renderer/keyframes/easing';
import { celExposures, newId } from './model';

/**
 * In-betweens: the drawings between two drawings, worked out rather than drawn.
 *
 * This is what Synfig does and what Pencil2D deliberately does not, and the
 * reason Pencil2D does not is worth stating: it only works when the two
 * drawings CORRESPOND. Two drawings of the same arm in two positions can be
 * blended; a drawing of an arm and a drawing of a face cannot, and no amount
 * of cleverness makes the result anything but a smear.
 *
 * So this refuses rather than guesses. It will only tween two drawings with
 * the same number of strokes, and it says plainly when it will not - a message
 * the user can act on beats a mess they have to undo.
 *
 * Within that rule it is forgiving: strokes are paired by where they SIT, not
 * by the order they were drawn, so redrawing the arm before the body still
 * tweens correctly.
 */

/** The most in-betweens worth making in one go; past this it is a flip-book, not a tween. */
export const MAX_TWEEN = 24;

/** Why a tween cannot be made, in words the panel can translate. */
export type TweenRefusal = 'noStart' | 'noEnd' | 'noGap' | 'differentStrokes' | 'tooMany';

export interface TweenPlan {
  /** The drawings to add, each already at its exposure. */
  cels: AnimationCel[];
}

/** The number of points every stroke is resampled to before blending. */
const SAMPLES = 48;

/** A stroke's points as x, y pairs, evenly spaced along its length. */
export function resample(stroke: Stroke, count = SAMPLES): number[] {
  const points = stroke.points;
  const total = points.length / 3;
  if (total === 0) return [];
  if (total === 1) {
    // A dot: the same place, over and over, so it blends like anything else.
    const out: number[] = [];
    for (let index = 0; index < count; index += 1) out.push(points[0], points[1], points[2]);
    return out;
  }

  // How far along the stroke each original point sits.
  const distances: number[] = [0];
  let length = 0;
  for (let index = 1; index < total; index += 1) {
    const dx = points[index * 3] - points[(index - 1) * 3];
    const dy = points[index * 3 + 1] - points[(index - 1) * 3 + 1];
    length += Math.hypot(dx, dy);
    distances.push(length);
  }
  // A stroke that went nowhere: every sample is its first point.
  if (length <= 0) {
    const out: number[] = [];
    for (let index = 0; index < count; index += 1) out.push(points[0], points[1], points[2]);
    return out;
  }

  const out: number[] = [];
  let at = 1;
  for (let index = 0; index < count; index += 1) {
    const wanted = (index / (count - 1)) * length;
    while (at < total - 1 && distances[at] < wanted) at += 1;
    const before = at - 1;
    const span = distances[at] - distances[before];
    const t = span > 0 ? (wanted - distances[before]) / span : 0;
    out.push(
      points[before * 3] + (points[at * 3] - points[before * 3]) * t,
      points[before * 3 + 1] + (points[at * 3 + 1] - points[before * 3 + 1]) * t,
      points[before * 3 + 2] + (points[at * 3 + 2] - points[before * 3 + 2]) * t,
    );
  }
  return out;
}

/** Where a stroke sits, for pairing one drawing's strokes with another's. */
function centreOf(stroke: Stroke): { x: number; y: number } {
  let x = 0;
  let y = 0;
  const total = stroke.points.length / 3;
  if (total === 0) return { x: 0, y: 0 };
  for (let index = 0; index < total; index += 1) {
    x += stroke.points[index * 3];
    y += stroke.points[index * 3 + 1];
  }
  return { x: x / total, y: y / total };
}

/**
 * Pair each stroke of `from` with one of `to`, nearest first.
 *
 * By position rather than by order, so a drawing whose strokes were made in a
 * different sequence still tweens. Greedy and nearest-first: the clearest pair
 * is taken first, which stops one ambiguous stroke dragging the rest wrong.
 */
export function pairStrokes(from: Stroke[], to: Stroke[]): { from: Stroke; to: Stroke }[] {
  const centresFrom = from.map(centreOf);
  const centresTo = to.map(centreOf);
  const candidates: { a: number; b: number; distance: number }[] = [];
  for (let a = 0; a < from.length; a += 1) {
    for (let b = 0; b < to.length; b += 1) {
      candidates.push({ a, b, distance: Math.hypot(centresFrom[a].x - centresTo[b].x, centresFrom[a].y - centresTo[b].y) });
    }
  }
  candidates.sort((one, two) => one.distance - two.distance);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: { from: Stroke; to: Stroke }[] = [];
  for (const candidate of candidates) {
    if (usedA.has(candidate.a) || usedB.has(candidate.b)) continue;
    usedA.add(candidate.a);
    usedB.add(candidate.b);
    pairs.push({ from: from[candidate.a], to: to[candidate.b] });
  }
  return pairs;
}

/** One stroke part way between two, at `t` from 0 to 1. */
export function blendStroke(from: Stroke, to: Stroke, t: number): Stroke {
  const a = resample(from);
  const b = resample(to);
  const points: number[] = [];
  for (let index = 0; index < a.length; index += 1) points.push(a[index] + (b[index] - a[index]) * t);
  return {
    id: newId('tween'),
    // The brush and the colour of the one it is coming FROM: a line does not
    // change colour halfway unless it was asked to, and blending two colours
    // gives a muddy third nobody chose.
    brush: from.brush,
    color: from.color,
    size: from.size + (to.size - from.size) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    points,
  };
}

/**
 * The drawings to put between the one at `fromExposure` and the one at
 * `toExposure`, or a word saying why there are none.
 *
 * The easing is the app's own, so an in-between run can ease in and out
 * exactly as a title does.
 */
export function planTween(
  layer: AnimationLayer,
  fromExposure: number,
  toExposure: number,
  easing: Easing = 'linear',
): TweenPlan | TweenRefusal {
  const start = layer.cels.find((cel) => cel.at === fromExposure);
  if (!start) return 'noStart';
  const end = layer.cels.find((cel) => cel.at === toExposure);
  if (!end || toExposure <= fromExposure) return 'noEnd';

  const gap = toExposure - fromExposure - 1;
  if (gap <= 0) return 'noGap';
  if (gap > MAX_TWEEN) return 'tooMany';

  // The rule that keeps this honest: same number of strokes, or nothing.
  if (start.strokes.length !== end.strokes.length || start.strokes.length === 0) return 'differentStrokes';

  const pairs = pairStrokes(start.strokes, end.strokes);
  const cels: AnimationCel[] = [];
  for (let step = 1; step <= gap; step += 1) {
    const t = easeProgress(step / (gap + 1), easing);
    cels.push({
      id: newId('cel'),
      at: fromExposure + step,
      strokes: pairs.map((pair) => blendStroke(pair.from, pair.to, t)),
    });
  }
  return { cels };
}

/**
 * The next drawing after `exposure` on this layer, which is what a tween from
 * here would run to. Null when this is the last one.
 */
export function nextCelAfter(layer: AnimationLayer, exposure: number): number | null {
  const after = celExposures(layer).find((at) => at > exposure);
  return after ?? null;
}

/** Whether a tween from here is possible at all, for enabling the button. */
export function canTween(layer: AnimationLayer | undefined, exposure: number): boolean {
  if (!layer) return false;
  const to = nextCelAfter(layer, exposure);
  if (to === null) return false;
  return typeof planTween(layer, exposure, to) !== 'string';
}
