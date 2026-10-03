import type { CaptionAnimation, CaptionAnimationKind, CaptionPreset, CaptionWord } from '@shared/types';
import { WORD_ANIMATION_KINDS, type WordAnimation, type WordPage, type WordTime } from '@renderer/text/wordAnimation';

/**
 * Captions that move word by word: what a track asks for, and when each
 * word of a caption is said.
 *
 * The times come from the transcription (CaptionContent.words). A caption
 * typed over by hand no longer says what was transcribed, so the words on
 * screen are matched against the ones heard: a word that is still there
 * keeps its time; one that was corrected takes the time of the word it
 * replaced; words put in or taken out share out the time between their
 * neighbours by their length. A caption with no times at all - typed, or
 * read from a file - shares out the time it is on screen.
 */

export const CAPTION_ANIMATION_KINDS: readonly CaptionAnimationKind[] = WORD_ANIMATION_KINDS;

/** The colour phone captions made familiar: a yellow that reads on any picture, with a dark outline. */
export const DEFAULT_ANIMATION_COLOR = '#ffe600';
export const MIN_PER_PAGE = 1;
export const MAX_PER_PAGE = 3;

/** What a kind starts as on a track of this preset. */
export function defaultAnimation(kind: CaptionAnimationKind, preset: CaptionPreset = 'classic'): CaptionAnimation {
  void preset;
  return { kind, color: DEFAULT_ANIMATION_COLOR, bounce: kind !== 'karaoke', perPage: 2 };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** An animation read from a file: an unknown kind is none; everything else made safe. */
export function normalizeCaptionAnimation(raw: unknown): CaptionAnimation | null {
  const source = (raw ?? null) as Partial<Record<keyof CaptionAnimation, unknown>> | null;
  if (!source || !CAPTION_ANIMATION_KINDS.includes(source.kind as CaptionAnimationKind)) return null;
  const kind = source.kind as CaptionAnimationKind;
  const perPage = typeof source.perPage === 'number' && Number.isFinite(source.perPage) ? Math.round(source.perPage) : 2;
  return {
    kind,
    color: typeof source.color === 'string' && HEX.test(source.color) ? source.color.toLowerCase() : DEFAULT_ANIMATION_COLOR,
    bounce: typeof source.bounce === 'boolean' ? source.bounce : kind !== 'karaoke',
    perPage: Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, perPage)),
  };
}

/* When each word is said ---------------------------------------------------------- */

/** The words of a caption as they are drawn: what is between its spaces and line breaks. */
export const captionTokens = (text: string): string[] => text.split(/\s+/).filter((token) => token !== '');

/** For telling whether two words are the same word: no case, no accents, no punctuation. */
const fold = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** How much of a stretch of time a word takes: its letters, and a little for being a word at all. */
const weight = (text: string): number => Math.max(1, [...fold(text)].length) + 1;

/** The shortest a word is given when time has to be found for it. */
const MIN_WORD_SECONDS = 0.12;

/** Share `from`..`to` out among words by their length. */
function share(texts: readonly string[], from: number, to: number): WordTime[] {
  const total = texts.reduce((sum, text) => sum + weight(text), 0);
  const span = Math.max(0, to - from);
  let at = from;
  return texts.map((text) => {
    const start = at;
    at += total > 0 ? (span * weight(text)) / total : 0;
    return { start, end: at };
  });
}

/** Pairs (token, stored word) that are the same word, in order: the longest such list. */
function matches(tokens: readonly string[], stored: readonly CaptionWord[]): Array<[number, number]> {
  const a = tokens.map(fold);
  const b = stored.map((word) => fold(word.text));
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] !== '' && a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== '' && a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * When each word of `text` is said, in the caption's content seconds.
 *
 * `stored` are the transcription's words (their times in the same seconds);
 * `span` is the stretch of content the caption is on screen for, which is
 * what there is to share out when there is nothing better.
 */
export function timedWords(text: string, stored: readonly CaptionWord[] | undefined, span: { from: number; to: number }): WordTime[] {
  const tokens = captionTokens(text);
  if (tokens.length === 0) return [];
  const known = stored ?? [];

  if (known.length === 0) {
    // Nothing heard: the words share the time on screen, less the moment a
    // caption stays up after its last word.
    const length = Math.max(0, span.to - span.from);
    return share(tokens, span.from, span.to - Math.min(0.4, length * 0.15));
  }
  if (known.length === tokens.length && known.every((word, index) => word.text === tokens[index])) {
    return known.map((word) => ({ start: word.start, end: Math.max(word.start, word.end) }));
  }

  const pairs = matches(tokens, known);
  const times: Array<WordTime | null> = tokens.map(() => null);
  for (const [token, word] of pairs) times[token] = { start: known[word].start, end: Math.max(known[word].start, known[word].end) };

  // The stretches between words that are still there.
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [tokens.length, known.length]];
  for (let at = 0; at + 1 < anchors.length; at += 1) {
    const [tokenBefore, wordBefore] = anchors[at];
    const [tokenAfter, wordAfter] = anchors[at + 1];
    const first = tokenBefore + 1;
    const count = tokenAfter - first;
    if (count <= 0) continue;
    const heard = known.slice(wordBefore + 1, wordAfter);

    // As many words as were heard there: each takes the place of one, exactly.
    if (heard.length === count) {
      heard.forEach((word, index) => (times[first + index] = { start: word.start, end: Math.max(word.start, word.end) }));
      continue;
    }
    // More or fewer: they share the time those took, or - words put in where
    // nothing was heard - the time between their neighbours.
    const before = tokenBefore >= 0 ? (times[tokenBefore] as WordTime) : null;
    const after = tokenAfter < tokens.length ? (times[tokenAfter] as WordTime) : null;
    let from = heard.length > 0 ? heard[0].start : before ? before.end : Math.min(span.from, after ? after.start : span.from);
    let to = heard.length > 0 ? Math.max(heard[heard.length - 1].start, heard[heard.length - 1].end) : after ? after.start : Math.max(span.to, from);
    let run = tokens.slice(first, tokenAfter);
    let runFirst = first;
    // No room between the neighbours: the word before gives up part of its own.
    if (to - from < MIN_WORD_SECONDS * count && before) {
      from = before.start;
      to = Math.max(to, before.end);
      run = tokens.slice(tokenBefore, tokenAfter);
      runFirst = tokenBefore;
    }
    share(run, from, Math.max(from, to)).forEach((time, index) => (times[runFirst + index] = time));
  }

  // In order, and never backwards: a word cannot start before the one before it.
  let floor = -Infinity;
  return times.map((time) => {
    const start = Math.max(floor, (time as WordTime).start);
    const end = Math.max(start, (time as WordTime).end);
    floor = start;
    return { start, end };
  });
}

/* Pages --------------------------------------------------------------------------- */

const endsSentence = (text: string): boolean => /[.!?…]["»”')\]]*$/.test(text);

/**
 * The words shown together: all of them, or - a few at a time - `perPage`
 * of them, never carrying on past the end of a sentence, so "todos." and
 * "Hoy" are not on screen as if they were one thought.
 */
export function wordPages(tokens: readonly string[], perPage: number | null): WordPage[] {
  if (tokens.length === 0) return [];
  if (perPage === null) return [{ first: 0, last: tokens.length - 1 }];
  const size = Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, Math.round(perPage)));
  const pages: WordPage[] = [];
  let first = 0;
  tokens.forEach((token, index) => {
    const full = index - first + 1 >= size;
    if (full || endsSentence(token) || index === tokens.length - 1) {
      pages.push({ first, last: index });
      first = index + 1;
    }
  });
  return pages;
}

/** What the text renderer needs to move a caption's words. */
export function wordAnimationFor(
  animation: CaptionAnimation,
  text: string,
  stored: readonly CaptionWord[] | undefined,
  span: { from: number; to: number },
): WordAnimation {
  const tokens = captionTokens(text);
  const times = timedWords(text, stored, span);
  const pages = wordPages(tokens, animation.kind === 'words' ? animation.perPage : null);
  return {
    kind: animation.kind,
    color: animation.color,
    bounce: animation.bounce,
    times,
    pages,
    key: `${animation.kind}|${animation.color}|${animation.bounce ? 1 : 0}|${pages.map((page) => page.last).join(',')}|${times.map((time) => `${time.start.toFixed(3)}-${time.end.toFixed(3)}`).join(',')}`,
  };
}
