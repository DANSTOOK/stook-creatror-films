import type { TitleAnimation, TitleEntrance, TitleExit } from '@shared/types';
import { animationFrames, easeExit, easeStandard, springBounce } from './animation';

/**
 * Entrances and exits that bring a title's letters, words or lines on one at
 * a time - typewriter, letter by letter, word by word, bouncing letters,
 * letters closing in, line by line - and the blur, which softens the whole
 * text. They cannot be done by moving one finished picture of the title, as
 * text/animation.ts's are, so the title is redrawn for each frame of the
 * entrance or exit (text/render.ts) and drawn once, at rest, in between.
 *
 * Like the rest of the title's animation this is a pure function of the
 * frame - counted from the clip's ends, on the motion system's curves - so
 * the viewer, the thumbnails and the export draw the same letters for the
 * same frame. The ideas are the common ones of kinetic typography; the code
 * is this app's own.
 */

export type TextMotionKind = 'blur' | 'typewriter' | 'letters' | 'words' | 'bounce' | 'tracking' | 'lines';

const ENTRANCES: ReadonlySet<TitleEntrance> = new Set<TitleEntrance>(['blur', 'typewriter', 'letters', 'words', 'bounce', 'tracking', 'lines']);
const EXITS: ReadonlySet<TitleExit> = new Set<TitleExit>(['blur', 'typewriter', 'letters', 'words', 'tracking', 'lines']);

export const isTextEntrance = (kind: TitleEntrance): boolean => ENTRANCES.has(kind);
export const isTextExit = (kind: TitleExit): boolean => EXITS.has(kind);

/** Whether a title's animation ever redraws its letters. */
export const hasTextMotion = (animation: TitleAnimation | undefined): boolean =>
  Boolean(animation && !animation.roll && (ENTRANCES.has(animation.in) || EXITS.has(animation.out)));

/** One frame of an entrance or exit that redraws the letters. */
export interface TextMotion {
  phase: 'in' | 'out';
  kind: TextMotionKind;
  /** 0 as it starts, towards 1 as it ends, evenly in time: each kind eases its own way. */
  progress: number;
  /** The same string for the same picture: part of the key the texture is kept under. */
  key: string;
}

/** What is drawn one at a time. */
export type MotionUnit = 'grapheme' | 'word' | 'line' | 'whole';

export function unitOf(kind: TextMotionKind): MotionUnit {
  switch (kind) {
    case 'typewriter':
    case 'letters':
    case 'bounce':
    case 'tracking':
      return 'grapheme';
    case 'words':
      return 'word';
    case 'lines':
      return 'line';
    case 'blur':
    default:
      return 'whole';
  }
}

/**
 * The redrawing entrance or exit at `frameFromStart` of a clip, or null when
 * the title is at rest there (or moves only as a whole picture).
 */
export function textMotionAt(animation: TitleAnimation | undefined, frameFromStart: number, durationFrames: number, fps: number): TextMotion | null {
  if (!animation || animation.roll) return null;
  const duration = Math.max(1, durationFrames);
  const at = Math.min(Math.max(frameFromStart, 0), duration);
  const { inFrames, outFrames } = animationFrames(animation, duration, fps);
  if (inFrames > 0 && at < inFrames && ENTRANCES.has(animation.in)) {
    const progress = at / inFrames;
    return { phase: 'in', kind: animation.in as TextMotionKind, progress, key: `in:${animation.in}:${progress.toFixed(5)}` };
  }
  const fromEnd = duration - at;
  if (outFrames > 0 && fromEnd < outFrames && EXITS.has(animation.out)) {
    const progress = 1 - Math.max(0, fromEnd) / outFrames;
    return { phase: 'out', kind: animation.out as TextMotionKind, progress, key: `out:${animation.out}:${progress.toFixed(5)}` };
  }
  return null;
}

/* How each piece stands ---------------------------------------------------------- */

/** One letter, word or line. Offsets are in ems of its own size; `spread` and `blur` are for the whole. */
export interface UnitState {
  opacity: number;
  /** Across and down, in ems (y down). */
  dx: number;
  dy: number;
  scale: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** How far the letters of Letter by letter and Bounce travel, in ems. */
export const LETTER_RISE = 0.35;
export const BOUNCE_DROP = 0.6;
/** How far apart Tracking starts (or ends) the letters, as a share of their distance from the line's middle. */
export const SPREAD = 0.35;
/** How soft Blur starts (or ends), in ems. */
export const BLUR_EMS = 0.25;
/** The size Words start from, and shrink by as they go. */
export const WORD_FROM = 0.6;
export const WORD_BY = 0.3;

/**
 * Where piece `index` of `count` is along a staggered run: each takes `span`
 * of the time, starting evenly one after another, so the first starts at 0
 * and the last ends at 1, whatever the count.
 */
export function staggered(progress: number, index: number, count: number, span: number): number {
  if (count <= 1) return clamp01(progress);
  const start = (index / (count - 1)) * (1 - span);
  return clamp01((progress - start) / span);
}

/** How long each piece takes of the whole, by kind: shorter for many small pieces. */
const spanFor = (kind: TextMotionKind, count: number): number => {
  if (kind === 'lines') return count <= 1 ? 1 : 0.7;
  if (kind === 'words') return count <= 1 ? 1 : Math.max(0.35, 0.8 / Math.sqrt(count));
  return count <= 1 ? 1 : Math.max(0.2, 1.6 / Math.sqrt(count + 4));
};

/** How many pieces Typewriter shows: none at the start, all of them as it ends. */
export function typedCount(motion: TextMotion, count: number): number {
  const typed = Math.floor(motion.progress * count + 1e-9);
  return motion.phase === 'in' ? Math.min(count, typed) : Math.max(0, count - typed);
}

/** How piece `index` of `count` stands in this frame. */
export function unitStateAt(motion: TextMotion, index: number, count: number): UnitState {
  const { kind, phase, progress } = motion;
  if (kind === 'typewriter') return { opacity: index < typedCount(motion, count) ? 1 : 0, dx: 0, dy: 0, scale: 1 };
  if (kind === 'blur') {
    const eased = phase === 'in' ? easeStandard(clamp01(progress)) : 1 - easeExit(clamp01(progress));
    return { opacity: eased, dx: 0, dy: 0, scale: 1 };
  }
  if (kind === 'tracking') {
    // The letters move together; only the whole fades.
    const eased = phase === 'in' ? easeStandard(clamp01(progress)) : 1 - easeExit(clamp01(progress));
    return { opacity: eased, dx: 0, dy: 0, scale: 1 };
  }
  const local = staggered(progress, index, count, spanFor(kind, count));
  if (phase === 'in') {
    const eased = easeStandard(local);
    switch (kind) {
      case 'letters':
        return { opacity: eased, dx: 0, dy: (1 - eased) * LETTER_RISE, scale: 1 };
      case 'bounce': {
        // Each letter drops in on the interface's spring, overshooting once.
        const spring = springBounce(local);
        return { opacity: easeStandard(clamp01(local * 3)), dx: 0, dy: -(1 - spring) * BOUNCE_DROP, scale: 1 };
      }
      case 'words':
        return { opacity: easeStandard(clamp01(local * 2)), dx: 0, dy: 0, scale: WORD_FROM + (1 - WORD_FROM) * springBounce(local) };
      case 'lines':
      default:
        // Up from behind the line's own edge: drawn clipped to it (render.ts).
        return { opacity: 1, dx: 0, dy: (1 - eased), scale: 1 };
    }
  }
  const gone = easeExit(local);
  switch (kind) {
    case 'letters':
      return { opacity: 1 - gone, dx: 0, dy: -gone * LETTER_RISE, scale: 1 };
    case 'words':
      return { opacity: 1 - gone, dx: 0, dy: 0, scale: 1 - WORD_BY * gone };
    case 'lines':
    default:
      return { opacity: 1, dx: 0, dy: -gone, scale: 1 };
  }
}

/** What applies to the whole text in this frame, and how far its background and shape have come. */
export interface WholeState {
  /** Blur radius in ems. */
  blur: number;
  /** Letters' distance from their line's middle, as a multiple: 1 at rest. */
  spread: number;
  /** The background box and the shape: 0 not there yet (or gone), 1 whole. */
  shapes: number;
  /** Typewriter's caret is drawn after the last letter typed. */
  caret: boolean;
}

export function wholeStateAt(motion: TextMotion): WholeState {
  const { kind, phase, progress } = motion;
  const shown = phase === 'in' ? easeStandard(clamp01(progress)) : 1 - easeExit(clamp01(progress));
  // The background and shape come on in the first part of the entrance, so
  // the letters arrive on something; they go in the last part of the exit.
  const shapes = phase === 'in' ? easeStandard(clamp01(progress * 2.5)) : 1 - easeExit(clamp01((progress - 0.6) / 0.4));
  return {
    blur: kind === 'blur' ? (1 - shown) * BLUR_EMS : 0,
    spread: kind === 'tracking' ? 1 + (1 - shown) * SPREAD : 1,
    shapes: kind === 'typewriter' ? (phase === 'in' ? 1 : shapes) : shapes,
    caret: kind === 'typewriter' && progress > 0 && progress < 1,
  };
}

/** Room a moving piece may take beyond the title at rest, in ems of the largest line: see render.ts. */
export const MOTION_MARGIN_EMS = Math.max(LETTER_RISE, BOUNCE_DROP * 1.3, BLUR_EMS * 3, 0.5);
