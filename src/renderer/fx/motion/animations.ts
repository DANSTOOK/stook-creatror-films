import type { BezierCurve, ClipTransform, Keyframe, KeyframeValue, Vector2D } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { createId } from '@shared/utils/id';
import { cubicBezierEase, evaluateKeyframes } from '@renderer/engine/KeyframeEvaluator';

/**
 * Clip animations: how a clip comes on, goes off, or keeps moving - the
 * In, Out and Loop animations of Filmora's and CapCut's Animation tab.
 *
 * Like the screen moves (presets.ts) they are written as the clip's own
 * transform keyframes - position, scale, rotation and opacity - so they cost
 * nothing to render and look the same in the viewer and in every export, and
 * the inspector shows them as keyframes anyone can adjust.
 *
 * An In animation plays over the clip's first moments and ends exactly on
 * the pose the clip has there; an Out animation leaves from the pose it has
 * where the animation starts. So one of each can sit on a clip together, and
 * a clip already moved, scaled or keyframed keeps that outside them. A Loop
 * animation repeats over the whole clip around its pose.
 *
 * The maths is pure data: the unit tests read it without a GPU or a store.
 */

export type ClipAnimationPhase = 'in' | 'out' | 'loop';

export type ClipAnimationId =
  | 'fadeIn'
  | 'popIn'
  | 'zoomPunch'
  | 'slideInLeft'
  | 'slideInRight'
  | 'slideInUp'
  | 'slideInDown'
  | 'spinIn'
  | 'dropIn'
  | 'shakeIn'
  | 'fadeOut'
  | 'popOut'
  | 'slideOutLeft'
  | 'slideOutRight'
  | 'slideOutDown'
  | 'spinOut'
  | 'pulse'
  | 'sway'
  | 'float';

/** A pose relative to the clip's own: scale and opacity multiply, the rest add. */
export interface AnimationPose {
  /** Factor on the clip's scale. */
  scale: number;
  /** Offset as a fraction of the frame's width and height. */
  x: number;
  y: number;
  /** Degrees added to the clip's rotation. */
  rotation: number;
  /** Factor on the clip's opacity. */
  opacity: number;
}

const REST: AnimationPose = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };

interface AnimationSpec {
  phase: ClipAnimationPhase;
  /** How long it plays, seconds - never more than 40 % of the clip. Loops: one cycle. */
  seconds: number;
  /**
   * The pose at `u` - 0 to 1 through the animation. An In animation is at
   * rest at 1, an Out one at 0; a loop is at rest at 0 and 1.
   */
  pose(u: number): Partial<AnimationPose>;
  /**
   * For a move that is one eased glide from its first pose to its last: the
   * cubic-bezier of that ease, so it is written as two keyframes with the
   * curve on the first - exactly the move - instead of a sample every other
   * frame.
   */
  curve?: BezierCurve;
  /**
   * For a move whose tracks each glide on a curve of their own (a spin that
   * turns on one ease and fades on a straight line): where each track's
   * keyframes go, as points through it, each with the curve to the next.
   */
  keys?: Partial<Record<TrackName, ReadonlyArray<{ u: number; curve?: BezierCurve }>>>;
}

type TrackName = 'position' | 'scale' | 'rotation' | 'opacity';

/** easeOutCubic and easeInCubic as CSS writes them (easings.net). */
const OUT_CUBIC: BezierCurve = { cp1: { x: 0.33, y: 1 }, cp2: { x: 0.68, y: 1 } };
const IN_CUBIC: BezierCurve = { cp1: { x: 0.32, y: 0 }, cp2: { x: 0.67, y: 0 } };
/** Past the end and back (easeOutBack), and its mirror (easeInBack), as CSS writes them. */
const OUT_BACK: BezierCurve = { cp1: { x: 0.34, y: 1.56 }, cp2: { x: 0.64, y: 1 } };
const IN_BACK: BezierCurve = { cp1: { x: 0.36, y: 0 }, cp2: { x: 0.66, y: -0.56 } };
const along = (u: number, curve: BezierCurve): number => cubicBezierEase(u, curve);

/* Easing curves for the sampled moves ---------------------------------------- */

const clamp01 = (u: number): number => Math.min(1, Math.max(0, u));
const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const easeInCubic = (u: number): number => u ** 3;
/** A ball dropped onto the floor: three bounces, each lower. */
const easeOutBounce = (u: number): number => {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u - 1.5 / d) ** 2 + 0.75;
  if (u < 2.5 / d) return n * (u - 2.25 / d) ** 2 + 0.9375;
  return n * (u - 2.625 / d) ** 2 + 0.984375;
};

/** Off the frame by a whole width or height, plus a little, so nothing of it shows. */
const OFF = 1.05;

const SPECS: Record<ClipAnimationId, AnimationSpec> = {
  fadeIn: { phase: 'in', seconds: 0.6, pose: (u) => ({ opacity: easeOutCubic(u) }), curve: OUT_CUBIC },
  popIn: {
    phase: 'in',
    seconds: 0.5,
    pose: (u) => ({ scale: 0.4 + 0.6 * along(u, OUT_BACK), opacity: clamp01(u * 2.5) }),
    keys: { scale: [{ u: 0, curve: OUT_BACK }, { u: 1 }], opacity: [{ u: 0 }, { u: 0.4 }, { u: 1 }] },
  },
  zoomPunch: { phase: 'in', seconds: 0.45, pose: (u) => ({ scale: 1 + 0.18 * (1 - easeOutCubic(u)) }), curve: OUT_CUBIC },
  slideInLeft: { phase: 'in', seconds: 0.55, pose: (u) => ({ x: -OFF * (1 - easeOutCubic(u)) }), curve: OUT_CUBIC },
  slideInRight: { phase: 'in', seconds: 0.55, pose: (u) => ({ x: OFF * (1 - easeOutCubic(u)) }), curve: OUT_CUBIC },
  slideInUp: { phase: 'in', seconds: 0.55, pose: (u) => ({ y: OFF * (1 - easeOutCubic(u)) }), curve: OUT_CUBIC },
  slideInDown: { phase: 'in', seconds: 0.55, pose: (u) => ({ y: -OFF * (1 - easeOutCubic(u)) }), curve: OUT_CUBIC },
  spinIn: {
    phase: 'in',
    seconds: 0.7,
    pose: (u) => ({ rotation: -180 * (1 - along(u, OUT_CUBIC)), scale: 0.2 + 0.8 * along(u, OUT_CUBIC), opacity: clamp01(u * 3) }),
    keys: { rotation: [{ u: 0, curve: OUT_CUBIC }, { u: 1 }], scale: [{ u: 0, curve: OUT_CUBIC }, { u: 1 }], opacity: [{ u: 0 }, { u: 1 / 3 }, { u: 1 }] },
  },
  dropIn: { phase: 'in', seconds: 0.8, pose: (u) => ({ y: -OFF * (1 - easeOutBounce(u)) }) },
  // A hit: the frame jolts, side to side and dying away.
  shakeIn: {
    phase: 'in',
    seconds: 0.5,
    pose: (u) => {
      const fade = (1 - u) ** 2;
      return { x: 0.025 * fade * Math.sin(u * Math.PI * 9), y: 0.015 * fade * Math.sin(u * Math.PI * 7 + 1), rotation: 1.5 * fade * Math.sin(u * Math.PI * 8), scale: 1 + 0.04 * fade };
    },
  },
  fadeOut: { phase: 'out', seconds: 0.6, pose: (u) => ({ opacity: 1 - easeInCubic(u) }), curve: IN_CUBIC },
  popOut: {
    phase: 'out',
    seconds: 0.45,
    pose: (u) => ({ scale: 1 - 0.6 * along(u, IN_BACK), opacity: clamp01((1 - u) * 2.5) }),
    keys: { scale: [{ u: 0, curve: IN_BACK }, { u: 1 }], opacity: [{ u: 0 }, { u: 0.6 }, { u: 1 }] },
  },
  slideOutLeft: { phase: 'out', seconds: 0.55, pose: (u) => ({ x: -OFF * easeInCubic(u) }), curve: IN_CUBIC },
  slideOutRight: { phase: 'out', seconds: 0.55, pose: (u) => ({ x: OFF * easeInCubic(u) }), curve: IN_CUBIC },
  slideOutDown: { phase: 'out', seconds: 0.55, pose: (u) => ({ y: OFF * easeInCubic(u) }), curve: IN_CUBIC },
  spinOut: {
    phase: 'out',
    seconds: 0.7,
    pose: (u) => ({ rotation: 180 * along(u, IN_CUBIC), scale: 1 - 0.8 * along(u, IN_CUBIC), opacity: clamp01((1 - u) * 3) }),
    keys: { rotation: [{ u: 0, curve: IN_CUBIC }, { u: 1 }], scale: [{ u: 0, curve: IN_CUBIC }, { u: 1 }], opacity: [{ u: 0 }, { u: 2 / 3 }, { u: 1 }] },
  },
  // A heartbeat: a little larger and back, about once a second.
  pulse: { phase: 'loop', seconds: 1, pose: (u) => ({ scale: 1 + 0.045 * Math.sin(u * Math.PI) ** 2 }) },
  // A slow rock, a couple of degrees each way, a touch closer so no corner shows.
  sway: { phase: 'loop', seconds: 2.4, pose: (u) => ({ rotation: 2 * Math.sin(u * Math.PI * 2), scale: 1.06 }) },
  // Drifting up and down as if on water, a touch closer so no edge shows.
  float: { phase: 'loop', seconds: 2.4, pose: (u) => ({ y: 0.018 * Math.sin(u * Math.PI * 2), scale: 1.05 }) },
};

export const CLIP_ANIMATIONS: readonly ClipAnimationId[] = Object.keys(SPECS) as ClipAnimationId[];
export const animationPhase = (id: ClipAnimationId): ClipAnimationPhase => SPECS[id].phase;
export const animationsOf = (phase: ClipAnimationPhase): ClipAnimationId[] => CLIP_ANIMATIONS.filter((id) => SPECS[id].phase === phase);
export const animationLabel = (id: ClipAnimationId): MessageKey => `fxa.${id}` as MessageKey;
export const isClipAnimation = (value: string): value is ClipAnimationId => Object.prototype.hasOwnProperty.call(SPECS, value);

/** The whole pose at `u`, rest where the animation says nothing. */
export function animationPoseAt(id: ClipAnimationId, u: number): AnimationPose {
  const spec = SPECS[id];
  if (!spec.curve) return { ...REST, ...spec.pose(clamp01(u)) };
  // A single glide goes along its own cubic-bezier, the one its keyframes carry, so the panel and the clip agree exactly.
  const from = { ...REST, ...spec.pose(0) };
  const to = { ...REST, ...spec.pose(1) };
  const k = cubicBezierEase(clamp01(u), spec.curve);
  const mixed = (key: keyof AnimationPose): number => from[key] + (to[key] - from[key]) * k;
  return { scale: mixed('scale'), x: mixed('x'), y: mixed('y'), rotation: mixed('rotation'), opacity: mixed('opacity') };
}

/**
 * What the tile in the panel shows at loop progress `t` (0..1): an In plays
 * through and holds, an Out holds then plays, a loop plays twice.
 */
export function animationPreview(id: ClipAnimationId, t: number): AnimationPose {
  const spec = SPECS[id];
  const p = clamp01(t);
  if (spec.phase === 'in') return animationPoseAt(id, p / 0.7);
  if (spec.phase === 'out') return animationPoseAt(id, (p - 0.3) / 0.7);
  return animationPoseAt(id, (p * 2) % 1);
}

/** How long an In or Out animation plays when nobody has said: its own length. */
export const animationSeconds = (id: ClipAnimationId): number => SPECS[id].seconds;
export const ANIMATION_SECONDS_MIN = 0.2;
export const ANIMATION_SECONDS_MAX = 3;

/**
 * The frames an animation takes on a clip: `seconds` (its own length if not
 * given), at most half the clip so an In and an Out never cross, at least
 * two frames.
 */
export function animationWindow(
  id: ClipAnimationId,
  clip: { startFrame: number; durationFrames: number },
  fps: number,
  seconds?: number,
): { from: number; to: number } {
  const spec = SPECS[id];
  const first = clip.startFrame;
  const last = clip.startFrame + Math.max(1, clip.durationFrames) - 1;
  if (spec.phase === 'loop') return { from: first, to: last };
  const wanted = seconds ?? spec.seconds;
  const share = seconds === undefined ? 0.4 : 0.5;
  const length = Math.max(2, Math.min(Math.round(wanted * fps), Math.floor(clip.durationFrames * share)));
  return spec.phase === 'in' ? { from: first, to: Math.min(last, first + length) } : { from: Math.max(first, last - length), to: last };
}

/** The pose a clip has at one frame: its transform there. */
export interface ClipPose {
  position: Vector2D;
  scale: Vector2D;
  rotation: number;
  opacity: number;
}

const key = <T extends KeyframeValue>(frame: number, value: T): Keyframe<T> => ({ id: createId('kf'), frame, value, easing: 'linear' });
const EASE_IN_OUT: BezierCurve = { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } };

const components = (value: KeyframeValue): number[] => (typeof value === 'number' ? [value] : [value.x, value.y]);

/**
 * A sampled move with the samples a straight line between their neighbours
 * already gives taken out (Ramer-Douglas-Peucker, frame against value): what
 * plays is the same to within `tolerance`, and the clip carries a handful
 * of keyframes rather than one every other frame. The first and last stay.
 */
export function simplified<T extends KeyframeValue>(keys: Keyframe<T>[], tolerance: number): Keyframe<T>[] {
  if (keys.length <= 2) return keys;
  const keepIt = new Array<boolean>(keys.length).fill(false);
  keepIt[0] = true;
  keepIt[keys.length - 1] = true;
  const spans: Array<[number, number]> = [[0, keys.length - 1]];
  while (spans.length > 0) {
    const [a, b] = spans.pop()!;
    const from = components(keys[a].value);
    const to = components(keys[b].value);
    const width = keys[b].frame - keys[a].frame;
    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i += 1) {
      const t = width > 0 ? (keys[i].frame - keys[a].frame) / width : 0;
      const here = components(keys[i].value);
      const off = Math.max(...here.map((v, c) => Math.abs(v - (from[c] + (to[c] - from[c]) * t))));
      if (off > worst) {
        worst = off;
        worstAt = i;
      }
    }
    if (worst > tolerance) {
      keepIt[worstAt] = true;
      spans.push([a, worstAt], [worstAt, b]);
    }
  }
  return keys.filter((_, i) => keepIt[i]);
}

/** Which of the four tracks an animation moves. */
export function touches(id: ClipAnimationId): { position: boolean; scale: boolean; rotation: boolean; opacity: boolean } {
  const samples = [0, 0.13, 0.29, 0.5, 0.71, 0.87, 1].map((u) => animationPoseAt(id, u));
  return {
    position: samples.some((pose) => pose.x !== 0 || pose.y !== 0),
    scale: samples.some((pose) => pose.scale !== 1),
    rotation: samples.some((pose) => pose.rotation !== 0),
    opacity: samples.some((pose) => pose.opacity !== 1),
  };
}

/**
 * The keyframes that play `id` over its window on a clip whose pose at the
 * window's resting edge is `rest`, merged into `transform`: on each track the
 * animation moves, the keyframes inside the window are replaced by its own,
 * and those outside are kept.
 *
 * An In or Out animation is sampled every other frame (linear between, which
 * at that spacing is its curve); a loop is two eased keyframes a cycle.
 */
export function withAnimation(
  transform: ClipTransform,
  id: ClipAnimationId,
  window: { from: number; to: number },
  rest: ClipPose,
  frame: { width: number; height: number },
  fps: number,
): ClipTransform {
  const spec = SPECS[id];
  const moves = touches(id);
  const frames: Array<{ frame: number; u: number; eased?: boolean }> = [];
  const span = Math.max(1, window.to - window.from);
  const cycle = Math.max(4, Math.round(spec.seconds * fps));
  if (spec.phase === 'loop') {
    // A quarter of a cycle apart, eased between - a sway's two extremes and its two
    // crossings. Spacing them wider to save keyframes would land on the wrong
    // phases and play the loop slower, or backwards, so a long clip gets many.
    const step = cycle / 4;
    for (let at = 0; at < span; at += step) frames.push({ frame: window.from + Math.round(at), u: (at % cycle) / cycle, eased: true });
    frames.push({ frame: window.to, u: (span % cycle) / cycle, eased: true });
  } else if (spec.curve) {
    frames.push({ frame: window.from, u: 0 }, { frame: window.to, u: 1 });
  } else {
    const step = span <= 8 ? 1 : 2;
    for (let at = 0; at < span; at += step) frames.push({ frame: window.from + at, u: at / span });
    frames.push({ frame: window.to, u: 1 });
  }
  // One keyframe a frame, the later sample winning.
  const unique = [...new Map(frames.map((sample) => [sample.frame, sample])).values()];

  const keep = <T extends KeyframeValue>(track: Keyframe<T>[]): Keyframe<T>[] => track.filter((kf) => kf.frame < window.from || kf.frame > window.to);
  /**
   * The track under the animation, when it moves inside the window - a
   * followed path, a size that tracks something - as a value at any frame.
   * Null when it rests there, which is what every animation was made for.
   */
  const movingUnder = <T extends KeyframeValue>(track: Keyframe<T>[], resting: T): ((at: number) => T) | null => {
    if (track.length < 2) return null;
    const at = (frame: number): T => evaluateKeyframes(track, frame, resting);
    const first = components(at(window.from));
    const step = Math.max(1, Math.round(span / 32));
    for (let frame = window.from; frame <= window.to; frame += step) {
      if (components(at(frame)).some((v, c) => Math.abs(v - first[c]) > 1e-6)) return at;
    }
    return null;
  };
  const merge = <T extends KeyframeValue>(
    track: Keyframe<T>[],
    resting: T,
    combine: (under: T, pose: AnimationPose) => T,
    tolerance: number,
    name: TrackName,
  ): Keyframe<T>[] => {
    const value = (pose: AnimationPose): T => combine(resting, pose);
    const under = movingUnder(track, resting);
    if (under) {
      // On top of what the track does, frame by frame: a pulse on a sticker that follows something
      // pulses where it now is, at the size it now is, instead of putting it back where it rested.
      const dense: Keyframe<T>[] = [];
      for (let at = window.from; at <= window.to; at += 1) {
        const u = spec.phase === 'loop' ? ((at - window.from) % cycle) / cycle : (at - window.from) / span;
        dense.push(key(at, combine(under(at), animationPoseAt(id, u))));
      }
      return [...keep(track), ...simplified(dense, tolerance)].sort((a, b) => a.frame - b.frame);
    }
    const points = spec.keys?.[name];
    if (points) {
      // Each track on its own curve, keyframes where the spec puts them.
      const placed = [...new Map(points.map((point) => [window.from + Math.round(point.u * span), point])).entries()].map(([at, point]) => {
        const kf = key(at, value(animationPoseAt(id, point.u)));
        return point.curve ? { ...kf, easing: 'bezier' as const, bezierParams: point.curve } : kf;
      });
      return [...keep(track), ...placed].sort((a, b) => a.frame - b.frame);
    }
    const own = unique.map(({ frame: at, u, eased }) => {
      const kf = key(at, value(animationPoseAt(id, u)));
      if (eased) return { ...kf, easing: 'bezier' as const, bezierParams: EASE_IN_OUT };
      // A single glide: its curve on the first of its two keyframes.
      return spec.curve && u === 0 ? { ...kf, easing: 'bezier' as const, bezierParams: spec.curve } : kf;
    });
    // A loop's eased keyframes are already few; a sampled move keeps only the samples it needs.
    return [...keep(track), ...(spec.phase === 'loop' || spec.curve ? own : simplified(own, tolerance))].sort((a, b) => a.frame - b.frame);
  };

  return {
    ...transform,
    // Tolerances below what can be seen on something in motion: a pixel, 0.2 % of the size, a quarter of a degree, 1 % opacity.
    position: moves.position
      ? merge(transform.position, rest.position, (under, pose) => ({ x: under.x + pose.x * frame.width, y: under.y + pose.y * frame.height }), 1, 'position')
      : transform.position,
    scale: moves.scale ? merge(transform.scale, rest.scale, (under, pose) => ({ x: under.x * pose.scale, y: under.y * pose.scale }), 0.002, 'scale') : transform.scale,
    rotation: moves.rotation ? merge(transform.rotation, rest.rotation, (under, pose) => under + pose.rotation, 0.25, 'rotation') : transform.rotation,
    opacity: moves.opacity ? merge(transform.opacity, rest.opacity, (under, pose) => Math.min(1, Math.max(0, under * pose.opacity)), 0.01, 'opacity') : transform.opacity,
  };
}

/**
 * `transform` with animation `id`'s keyframes taken out of `window` again,
 * on the tracks it moves; keyframes outside it are left alone.
 */
export function withoutAnimation(transform: ClipTransform, id: ClipAnimationId, window: { from: number; to: number }): ClipTransform {
  const moves = touches(id);
  const keep = <T extends KeyframeValue>(track: Keyframe<T>[]): Keyframe<T>[] => track.filter((kf) => kf.frame < window.from || kf.frame > window.to);
  return {
    ...transform,
    position: moves.position ? keep(transform.position) : transform.position,
    scale: moves.scale ? keep(transform.scale) : transform.scale,
    rotation: moves.rotation ? keep(transform.rotation) : transform.rotation,
    opacity: moves.opacity ? keep(transform.opacity) : transform.opacity,
  };
}
