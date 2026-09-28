import type { TitleAnimation, TitleEntrance, TitleExit, TitlePreset } from '@shared/types';
import { EASE_EXIT, SPRINGS } from '@renderer/motion/tokens.generated';
import { cubicBezierEase } from '@renderer/engine/KeyframeEvaluator';

/**
 * A title coming on and going off, worked out for one frame.
 *
 * The curves are the motion system's own (motion/tokens): an entrance
 * decelerates on the standard curve, an exit accelerates on the exit curve,
 * and Pop scales on the standard spring with the 0.25 bounce the interface
 * uses. Only movement bounces: opacity never does, as in the interface.
 *
 * They are evaluated here, per frame, from the clip's own frame count -
 * never as CSS - so the viewer, the scopes and the export all get the same
 * number for the same frame. And they are measured from the clip's ends, the
 * way its fades are (timing/clipFades): the first frame of an entrance shows
 * nothing, and trimming the clip carries the exit with its end.
 */

export const TITLE_ENTRANCES: readonly TitleEntrance[] = ['none', 'fade', 'rise', 'pop', 'wipe'];
export const TITLE_EXITS: readonly TitleExit[] = ['none', 'fade', 'drop', 'vanish'];

/** About half a second on, a third of a second off: exits are quicker, as in the interface. */
export const DEFAULT_IN_SECONDS = 0.5;
export const DEFAULT_OUT_SECONDS = 0.33;

/** How far Rise comes up from and Drop falls to, as a share of the frame's height. */
export const TRAVEL = 0.04;
/** The size Pop starts from, and Vanish shrinks by. */
export const POP_FROM = 0.8;
export const VANISH_BY = 0.15;
/** The width of Wipe's soft edge, as a share of the title's width. */
export const WIPE_SOFTNESS = 0.12;
/** A reveal at or beyond this shows the whole title: nothing is wiped. */
export const REVEAL_ALL = 2;

export const NO_ANIMATION: TitleAnimation = { in: 'none', inSeconds: DEFAULT_IN_SECONDS, out: 'none', outSeconds: DEFAULT_OUT_SECONDS, roll: false };

/** Each template's animation. */
export function presetAnimation(preset: TitlePreset): TitleAnimation {
  switch (preset) {
    case 'lowerThird':
      return { in: 'rise', inSeconds: DEFAULT_IN_SECONDS, out: 'fade', outSeconds: DEFAULT_OUT_SECONDS, roll: false };
    case 'credits':
      return { in: 'none', inSeconds: DEFAULT_IN_SECONDS, out: 'none', outSeconds: DEFAULT_OUT_SECONDS, roll: true };
    case 'title':
    default:
      return { in: 'fade', inSeconds: DEFAULT_IN_SECONDS, out: 'fade', outSeconds: DEFAULT_OUT_SECONDS, roll: false };
  }
}

const clampSeconds = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(5, Math.max(0.05, value)) : fallback;

/** An animation read from a file: anything unknown is none, any length kept in range. */
export function normalizeAnimation(raw: unknown): TitleAnimation {
  const source = (raw ?? {}) as Partial<Record<keyof TitleAnimation, unknown>>;
  return {
    in: TITLE_ENTRANCES.includes(source.in as TitleEntrance) ? (source.in as TitleEntrance) : 'none',
    inSeconds: clampSeconds(source.inSeconds, DEFAULT_IN_SECONDS),
    out: TITLE_EXITS.includes(source.out as TitleExit) ? (source.out as TitleExit) : 'none',
    outSeconds: clampSeconds(source.outSeconds, DEFAULT_OUT_SECONDS),
    roll: source.roll === true,
  };
}

/* The curves ---------------------------------------------------------------------- */

/** The standard curve, cubic-bezier(0.2, 0, 0, 1): what comes on slows as it lands. */
const STANDARD = { cp1: { x: 0.2, y: 0 }, cp2: { x: 0, y: 1 } };

/** The exit curve (motion tokens' EASE_EXIT): what goes off speeds up as it leaves. */
const EXIT = (() => {
  const [x1, y1, x2, y2] = EASE_EXIT.match(/[\d.]+/g)!.map(Number);
  return { cp1: { x: x1, y: y1 }, cp2: { x: x2, y: y2 } };
})();

export const easeStandard = (t: number): number => cubicBezierEase(t, STANDARD);
export const easeExit = (t: number): number => cubicBezierEase(t, EXIT);

/** The standard spring with the interface's bounce, sampled along 0..1 of its settle time. */
export function springBounce(t: number): number {
  const points = SPRINGS.standardBounce.points;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const at = t * (points.length - 1);
  const index = Math.floor(at);
  const next = Math.min(points.length - 1, index + 1);
  return points[index] + (points[next] - points[index]) * (at - index);
}

/* One frame ----------------------------------------------------------------------- */

export interface TitleAnimationState {
  /** Multiplies the clip's opacity. */
  opacity: number;
  /** Added to the clip's position, in project pixels (y down). */
  offset: { x: number; y: number };
  /** Multiplies the clip's scale, about the title's origin. */
  scale: number;
  /** Where Wipe's edge is across the title, 0..1; REVEAL_ALL shows everything. */
  reveal: number;
}

export const RESTING: TitleAnimationState = { opacity: 1, offset: { x: 0, y: 0 }, scale: 1, reveal: REVEAL_ALL };

/** Frames on and off, kept inside the clip and never overlapping, as fades are. */
export function animationFrames(animation: TitleAnimation, durationFrames: number, fps: number): { inFrames: number; outFrames: number } {
  const duration = Math.max(0, durationFrames);
  const wantedIn = animation.in === 'none' ? 0 : Math.max(1, Math.round(animation.inSeconds * fps));
  const wantedOut = animation.out === 'none' ? 0 : Math.max(1, Math.round(animation.outSeconds * fps));
  if (wantedIn + wantedOut <= duration) return { inFrames: wantedIn, outFrames: wantedOut };
  const total = wantedIn + wantedOut;
  const inFrames = Math.round((wantedIn / total) * duration);
  return { inFrames, outFrames: duration - inFrames };
}

/**
 * How a title stands at `frameFromStart` of a clip `durationFrames` long.
 *
 * `frameHeight` sizes the travel; `block` - the text's box on the frame,
 * before any transform - is what the credits roll moves through the frame.
 */
export function titleAnimationAt(
  animation: TitleAnimation | undefined,
  frameFromStart: number,
  durationFrames: number,
  fps: number,
  frameHeight: number,
  block?: { y: number; height: number },
): TitleAnimationState {
  if (!animation) return RESTING;
  const duration = Math.max(1, durationFrames);
  const at = Math.min(Math.max(frameFromStart, 0), duration);

  if (animation.roll) {
    // From the text's top on the frame's bottom edge to its bottom on the top
    // edge, at one speed: the same number of pixels every frame.
    if (!block) return RESTING;
    const travel = frameHeight + block.height;
    const start = frameHeight - block.y;
    return { ...RESTING, offset: { x: 0, y: start - (travel * at) / duration } };
  }

  const { inFrames, outFrames } = animationFrames(animation, duration, fps);
  const state: TitleAnimationState = { opacity: 1, offset: { x: 0, y: 0 }, scale: 1, reveal: REVEAL_ALL };

  if (inFrames > 0 && at < inFrames) {
    const progress = at / inFrames;
    const eased = easeStandard(progress);
    switch (animation.in) {
      case 'fade':
        state.opacity *= eased;
        break;
      case 'rise':
        state.opacity *= eased;
        state.offset.y += (1 - eased) * TRAVEL * frameHeight;
        break;
      case 'pop':
        // The size springs, with its bounce; the opacity only eases in.
        state.opacity *= eased;
        state.scale *= POP_FROM + (1 - POP_FROM) * springBounce(progress);
        break;
      case 'wipe':
        // The soft edge crosses from just before the left of the title to its right.
        state.reveal = -WIPE_SOFTNESS + (1 + WIPE_SOFTNESS) * eased;
        break;
      default:
        break;
    }
  }

  const fromEnd = duration - at;
  if (outFrames > 0 && fromEnd < outFrames) {
    // How far through the exit, 0 as it starts, accelerating.
    const gone = easeExit(1 - Math.max(0, fromEnd) / outFrames);
    switch (animation.out) {
      case 'fade':
        state.opacity *= 1 - gone;
        break;
      case 'drop':
        state.opacity *= 1 - gone;
        state.offset.y += gone * TRAVEL * frameHeight;
        break;
      case 'vanish':
        state.opacity *= 1 - gone;
        state.scale *= 1 - VANISH_BY * gone;
        break;
      default:
        break;
    }
  }

  state.opacity = Math.min(1, Math.max(0, state.opacity));
  return state;
}
