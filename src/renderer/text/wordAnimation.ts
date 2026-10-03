import type { TitleContent } from '@shared/types';
import { SPRINGS } from '@renderer/motion/tokens.generated';
import { easeStandard, springBounce } from './animation';

/**
 * Text that moves word by word, worked out for one moment.
 *
 * What a caption does as its words are said - the word being said takes a
 * colour, a box follows it, the colour fills the line like karaoke, the
 * words come on one by one, or two words at a time fill the screen. Which of
 * those, with which colour, and when each word is said, is a WordAnimation;
 * `wordFrameAt` says how every word stands at a given second.
 *
 * Pure, and counted in the clip's own seconds, which the compositor gets
 * from the frame it is drawing - never from a clock, never from CSS. So the
 * viewer and the export ask the same question for the same frame and get the
 * same answer, and a frame can be checked in a unit test.
 *
 * Movement uses the motion system's own curves (motion/tokens): a word
 * springs with the interface's bounce (`standardBounce`, 0.25), over that
 * spring's own time, in seconds of video; what fades eases on the standard
 * curve and does not bounce, as in the interface.
 */

export type WordAnimationKind = 'highlight' | 'box' | 'karaoke' | 'appear' | 'words';

export const WORD_ANIMATION_KINDS: readonly WordAnimationKind[] = ['highlight', 'box', 'karaoke', 'appear', 'words'];

/** When a word is said, in seconds of the clip's content. */
export interface WordTime {
  start: number;
  end: number;
}

/** Words shown together: all of them, or - for `words` - a few at a time. Indexes into the text's words. */
export interface WordPage {
  first: number;
  last: number;
}

export interface WordAnimation {
  kind: WordAnimationKind;
  /** The colour of the word being said, `#rrggbb`. */
  color: string;
  /** Movement springs; without it, things change on the cut. */
  bounce: boolean;
  /** One per word of the text, in order, never running backwards. */
  times: readonly WordTime[];
  /** In order, covering every word once. */
  pages: readonly WordPage[];
  /** All of the above as a string: part of the key the picture is cached under. */
  key: string;
}

/** How long a spring takes to settle, in seconds of video: the token's own time. */
export const POP_SECONDS = SPRINGS.standardBounce.settleMs / 1000;
/** How long a word takes to go back to its size once the next one is being said. */
export const SETTLE_SECONDS = 0.15;
/** How much larger the word being said is drawn. */
export const EMPHASIS = 0.12;
/** The size a word, a page or a box comes on from. */
export const ENTER_FROM = 0.8;
/** The spring passes its resting value before it settles: the most any scale here overshoots by. */
export const SPRING_PEAK = Math.max(...SPRINGS.standardBounce.points);

/** How one word stands. */
export interface WordState {
  visible: boolean;
  /** 0: the text's colour. 1: the animation's. Between: filled with it that far from the left. */
  fill: number;
  /** About the word's own middle. */
  scale: number;
  opacity: number;
}

/** The box behind the word being said. */
export interface WordBox {
  /** The word it is on. */
  to: number;
  /** The word it comes from, when it glides; null when it comes on in place. */
  from: number | null;
  /** 0 at `from` (or as it comes on), 1 at rest on `to`; past 1 as the spring overshoots. */
  progress: number;
  opacity: number;
}

export interface WordFrame {
  /** Which page is on screen. */
  page: number;
  /** The word being said, or -1 before the first. */
  active: number;
  /** One per word of the text. */
  words: WordState[];
  box: WordBox | null;
  /** The same string for the same picture: frames that share it share a texture. */
  key: string;
}

const AT_REST: WordState = { visible: true, fill: 0, scale: 1, opacity: 1 };
const HIDDEN: WordState = { visible: false, fill: 0, scale: 1, opacity: 0 };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** A frame is never closer to a word's start than this without being on it. */
const EPSILON = 1e-4;

/** The word being said at `seconds`: the last one that has started. -1 before the first. */
export function activeWord(times: readonly WordTime[], seconds: number): number {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (times[middle].start <= seconds + EPSILON) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** The page a word is on. */
export function pageOf(pages: readonly WordPage[], word: number): number {
  const at = pages.findIndex((page) => word >= page.first && word <= page.last);
  return at === -1 ? 0 : at;
}

/** The size of the word being said, `since` seconds after it began. */
const emphasised = (since: number): number => 1 + EMPHASIS * springBounce(since / POP_SECONDS);

/** How a thing comes on: its size springs from ENTER_FROM, its opacity eases in over the first half. */
const entering = (since: number): { scale: number; opacity: number } => {
  const progress = since / POP_SECONDS;
  return { scale: ENTER_FROM + (1 - ENTER_FROM) * springBounce(progress), opacity: easeStandard(clamp01(progress * 2)) };
};

const round = (value: number): string => (Math.round(value * 1000) / 1000).toString();

/** How every word stands at `seconds` of the clip's content. */
export function wordFrameAt(animation: WordAnimation, seconds: number): WordFrame {
  const { kind, bounce, times, pages } = animation;
  const active = activeWord(times, seconds);
  const page = pageOf(pages, Math.max(0, active));
  const shown = pages[page] ?? { first: 0, last: times.length - 1 };
  const since = active >= 0 ? Math.max(0, seconds - times[active].start) : 0;

  /** The word before, going back to its size from wherever its spring had got to. */
  const released = (index: number): number => {
    if (!bounce || index !== active - 1 || index < shown.first) return 1;
    const reached = emphasised(times[active].start - times[index].start);
    return 1 + (reached - 1) * (1 - easeStandard(clamp01(since / SETTLE_SECONDS)));
  };

  const words: WordState[] = times.map((time, index) => {
    switch (kind) {
      case 'highlight':
        if (index === active) return { visible: true, fill: 1, scale: bounce ? emphasised(since) : 1, opacity: 1 };
        return { ...AT_REST, scale: released(index) };
      case 'box':
        return AT_REST;
      case 'karaoke':
        if (index < active) return { ...AT_REST, fill: 1 };
        if (index === active) return { ...AT_REST, fill: clamp01((seconds - time.start) / Math.max(0.05, time.end - time.start)) };
        return AT_REST;
      case 'appear': {
        if (index > active) return HIDDEN;
        if (index < active) return AT_REST;
        const on = bounce ? entering(since) : { scale: 1, opacity: 1 };
        return { visible: true, fill: 1, scale: on.scale, opacity: on.opacity };
      }
      case 'words':
      default: {
        // Nothing before the first word is said; then one page at a time.
        if (active < 0 || index < shown.first || index > shown.last) return HIDDEN;
        const on = bounce ? entering(seconds - times[shown.first].start) : { scale: 1, opacity: 1 };
        const own = index === active ? (bounce ? emphasised(since) : 1) : released(index);
        return { visible: true, fill: index === active ? 1 : 0, scale: on.scale * own, opacity: on.opacity };
      }
    }
  });

  let box: WordBox | null = null;
  if (kind === 'box' && active >= 0) {
    const glides = bounce && active > shown.first;
    const progress = bounce ? springBounce(since / POP_SECONDS) : 1;
    box = { to: active, from: glides ? active - 1 : null, progress, opacity: bounce && !glides ? easeStandard(clamp01((since / POP_SECONDS) * 2)) : 1 };
  }

  const parts = [`p${page}`, `a${active}`];
  for (let index = shown.first; index <= shown.last && index < words.length; index += 1) {
    const word = words[index];
    parts.push(word.visible ? `${round(word.fill)},${round(word.scale)},${round(word.opacity)}` : '-');
  }
  if (box) parts.push(`b${box.from ?? 'x'},${round(box.progress)},${round(box.opacity)}`);
  return { page, active, words, box, key: parts.join('|') };
}

/* Which text moves ---------------------------------------------------------------- */

/**
 * A title's word animation, kept beside the title rather than in it: titles
 * are saved in project files, and this is worked out from a caption each
 * time it is drawn (captions/captionRender). A title object is never edited
 * in place, so the tie holds for as long as the object does.
 */
const animations = new WeakMap<TitleContent, WordAnimation>();

export function setWordAnimation(title: TitleContent, animation: WordAnimation): void {
  animations.set(title, animation);
}

export const wordAnimationOf = (title: TitleContent): WordAnimation | undefined => animations.get(title);
