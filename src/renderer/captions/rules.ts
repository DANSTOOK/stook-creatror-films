import type { CaptionLanguage, CaptionPreset, CaptionWord } from '@shared/types';

/**
 * How words become captions: which words go together, where a line breaks,
 * and how long each caption stays up.
 *
 * The numbers are Netflix's, from its timed-text guides - the general one,
 * the Spanish (Latin America and Spain) one, and the timing one:
 *   https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617
 *   https://partnerhelp.netflixstudios.com/hc/en-us/articles/217349997
 *   https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394
 * - 42 characters a line, two lines at most, one when it fits;
 * - up to 17 characters a second for adults;
 * - on screen from 5/6 of a second to 7 seconds;
 * - 2 frames between captions, or at least half a second: shorter gaps are
 *   closed to 2 frames ("chaining"), and a caption stays up half a second
 *   past the words when nothing follows at once;
 * - a line breaks after punctuation or before a conjunction or preposition,
 *   and never between an article and its noun.
 *
 * Pure, times in seconds; the timeline's frames only come in for the gap.
 */

export interface CaptionRules {
  maxCharsPerLine: number;
  maxLines: number;
  /** Characters a second, spaces and punctuation included. */
  maxCps: number;
  minSeconds: number;
  maxSeconds: number;
  gapFrames: number;
  /** Gaps shorter than this are closed to `gapFrames`. */
  closeGapsUnder: number;
  /** How long a caption may stay up after its last word, room permitting. */
  lagOut: number;
  /** A pause at least this long between words starts a new caption. */
  pauseBreak: number;
}

export const NETFLIX: Omit<CaptionRules, 'maxCharsPerLine' | 'maxLines'> = {
  maxCps: 17,
  minSeconds: 5 / 6,
  maxSeconds: 7,
  gapFrames: 2,
  closeGapsUnder: 0.5,
  lagOut: 0.5,
  pauseBreak: 0.7,
};

/**
 * The rules for a preset. A tall (portrait) frame has less room across, so
 * a classic line there holds 32 characters - drawn larger than it would fit
 * at 42 (see captionRender).
 */
export function rulesFor(preset: CaptionPreset, frame: { width: number; height: number } = { width: 16, height: 9 }): CaptionRules {
  const portrait = frame.width < frame.height;
  if (preset === 'social') return { ...NETFLIX, maxCharsPerLine: portrait ? 22 : 28, maxLines: 1, pauseBreak: 0.5 };
  return { ...NETFLIX, maxCharsPerLine: portrait ? 32 : 42, maxLines: 2 };
}

/**
 * Words a line must not end on: the article, preposition or conjunction
 * belongs with the word after it ("la | casa" is wrong, "la casa" is one
 * unit). Also the short pronouns that sit before a verb in Spanish ("se |
 * puede").
 */
const WEAK: Record<CaptionLanguage, ReadonlySet<string>> = {
  es: new Set(
    (
      'el la los las un una unos unas lo al del ' +
      'a ante bajo con contra de desde en entre hacia hasta para por según segun sin sobre tras ' +
      'y e o u ni que pero sino mas porque como si cuando donde ' +
      'mi mis tu tus su sus nuestro nuestra nuestros nuestras este esta estos estas ese esa esos esas ' +
      'se me te le les nos no muy más mas'
    ).split(' '),
  ),
  en: new Set(
    (
      'a an the ' +
      'of to in on at by for with from into onto about over under after before between through ' +
      'and or but nor so that if as than ' +
      'my your his her its our their this these those ' +
      'is are was were be not very'
    ).split(' '),
  ),
};

const bare = (word: string): string =>
  word
    .toLowerCase()
    .replace(/^[¿¡"«(]+/, '')
    .replace(/[.,;:!?…"»)]+$/, '');

/** A line or caption should not end on this word. */
export const isWeak = (word: string, language: CaptionLanguage): boolean => {
  if (/[.,;:!?…»)"]$/.test(word)) return false;
  return WEAK[language].has(bare(word));
};

const endsSentence = (word: string): boolean => /[.!?…]["»)]?$/.test(word);
const endsClause = (word: string): boolean => /[,;:]["»)]?$/.test(word) || endsSentence(word);

const joined = (words: readonly string[]): string => words.join(' ');

/**
 * Break a caption's words into at most `maxLines` lines of `maxCharsPerLine`.
 *
 * One line when it fits (the guide keeps text on one line unless it has to
 * break). Two lines otherwise, at the break that costs least: never after a
 * weak word, preferably after punctuation, as even as possible and, when
 * uneven, with the longer line underneath (the "pyramid"). Returns null when
 * the words do not fit in the lines allowed.
 */
export function breakLines(words: readonly string[], rules: Pick<CaptionRules, 'maxCharsPerLine' | 'maxLines'>, language: CaptionLanguage): string[] | null {
  if (words.length === 0) return [''];
  const whole = joined(words);
  if (whole.length <= rules.maxCharsPerLine) return [whole];
  if (rules.maxLines < 2) return null;

  let best: { lines: string[]; cost: number } | null = null;
  for (let split = 1; split < words.length; split += 1) {
    const top = joined(words.slice(0, split));
    const bottom = joined(words.slice(split));
    if (top.length > rules.maxCharsPerLine || bottom.length > rules.maxCharsPerLine) continue;
    const last = words[split - 1];
    let cost = Math.abs(top.length - bottom.length);
    // The longer line underneath, a little.
    if (top.length > bottom.length) cost += 4;
    if (isWeak(last, language)) cost += 1000;
    if (endsClause(last)) cost -= 12;
    if (!best || cost < best.cost) best = { lines: [top, bottom], cost };
  }
  return best?.lines ?? null;
}

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  lines: string[];
  words: CaptionWord[];
}

const fits = (words: readonly CaptionWord[], rules: CaptionRules, language: CaptionLanguage): boolean =>
  breakLines(
    words.map((word) => word.text),
    rules,
    language,
  ) !== null && words[words.length - 1].end - words[0].start <= rules.maxSeconds;

/** Fits, and without its first line ending on a weak word: the only break it has may be a bad one. */
function fitsWell(words: readonly CaptionWord[], rules: CaptionRules, language: CaptionLanguage): boolean {
  if (!fits(words, rules, language)) return false;
  const lines = breakLines(
    words.map((word) => word.text),
    rules,
    language,
  );
  return !lines || lines.length < 2 || !isWeak(lines[0].split(' ').pop() ?? '', language);
}

/**
 * Cut a run of words (a sentence, or what lies between two pauses) into
 * captions that each fit.
 *
 * Not greedily: filling each caption to the brim leaves the sentence's last
 * three words alone on screen. The run is cut into as few captions as it
 * needs, each near an equal share of it, at the comma nearest that share
 * when there is one and never after a weak word when that can be helped.
 * A run that fits in one caption only by ending a line on a weak word is
 * cut in two as well, when that gives two captions that break properly.
 */
function cutRun(run: CaptionWord[], rules: CaptionRules, language: CaptionLanguage): CaptionWord[][] {
  if (run.length === 0) return [];
  if (fitsWell(run, rules, language)) return [run];
  const wholeFits = fits(run, rules, language);

  // The fewest captions that hold it, found by filling each to the brim.
  let needed = 0;
  for (let at = 0; at < run.length; needed += 1) {
    let count = 1;
    while (at + count < run.length && fits(run.slice(at, at + count + 1), rules, language)) count += 1;
    at += count;
  }

  const chars = (n: number): number => joined(run.slice(0, n).map((word) => word.text)).length;
  const share = chars(run.length) / Math.max(2, needed);
  const pick = (accept: (head: CaptionWord[], tail: CaptionWord[]) => boolean): number | null => {
    let best: { cut: number; cost: number } | null = null;
    for (let n = 1; n < run.length; n += 1) {
      const head = run.slice(0, n);
      if (!fits(head, rules, language)) break;
      if (!accept(head, run.slice(n))) continue;
      const last = run[n - 1].text;
      let cost = Math.abs(chars(n) - share);
      if (isWeak(last, language)) cost += 1000;
      if (endsClause(last)) cost -= share * 0.35;
      if (!best || cost < best.cost) best = { cut: n, cost };
    }
    return best?.cut ?? null;
  };

  // A caption that breaks properly, not ending on a weak word itself.
  const good = pick((head) => fitsWell(head, rules, language) && !isWeak(head[head.length - 1].text, language));
  // One that fitted whole is only cut when both halves come out well.
  if (wholeFits) {
    const both = pick((head, tail) => fitsWell(head, rules, language) && !isWeak(head[head.length - 1].text, language) && fitsWell(tail, rules, language));
    return both === null ? [run] : [run.slice(0, both), run.slice(both)];
  }
  const cut = good ?? pick(() => true) ?? 1;
  return [run.slice(0, cut), ...cutRun(run.slice(cut), rules, language)];
}

/**
 * Words into timed captions. `fps` is the timeline's, for the 2-frame gap.
 */
export function wordsToCues(words: readonly CaptionWord[], rules: CaptionRules, language: CaptionLanguage, fps: number): Cue[] {
  const clean = words.filter((word) => word.text.trim() !== '');
  if (clean.length === 0) return [];

  // Runs: split after a sentence ends and at pauses.
  const runs: CaptionWord[][] = [];
  let run: CaptionWord[] = [];
  clean.forEach((word, index) => {
    const previous = clean[index - 1];
    if (previous && run.length > 0 && (endsSentence(previous.text) || word.start - previous.end >= rules.pauseBreak)) {
      runs.push(run);
      run = [];
    }
    run.push(word);
  });
  if (run.length > 0) runs.push(run);

  const groups = runs.flatMap((piece) => cutRun(piece, rules, language));

  // Two short sentences that fit together, each on its own line, with
  // hardly a pause between them, read better as one caption than as two
  // flashes (two lines only: a one-line style keeps them apart).
  const merged: CaptionWord[][] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && rules.maxLines >= 2) {
      const a = joined(previous.map((word) => word.text));
      const b = joined(group.map((word) => word.text));
      const pause = group[0].start - previous[previous.length - 1].end;
      const span = group[group.length - 1].end - previous[0].start;
      const short = previous[previous.length - 1].end - previous[0].start < 1.5;
      if (short && pause < 0.4 && a.length <= rules.maxCharsPerLine && b.length <= rules.maxCharsPerLine && span <= rules.maxSeconds && endsSentence(previous[previous.length - 1].text)) {
        merged[merged.length - 1] = [...previous, ...group];
        continue;
      }
    }
    merged.push(group);
  }

  const cues: Cue[] = merged.map((group) => {
    const texts = group.map((word) => word.text);
    return {
      start: group[0].start,
      end: group[group.length - 1].end,
      lines: breakLinesAtSentence(texts, rules) ?? breakLines(texts, rules, language) ?? breakLinesGreedy(texts, rules.maxCharsPerLine),
      words: group,
    };
  });

  return timeCues(cues, rules, fps);
}

/** Two sentences in one caption: one per line, when each fits a line. */
function breakLinesAtSentence(texts: readonly string[], rules: CaptionRules): string[] | null {
  const whole = joined(texts);
  if (whole.length <= rules.maxCharsPerLine || rules.maxLines < 2) return null;
  const at = texts.findIndex((text, index) => index < texts.length - 1 && endsSentence(text));
  if (at === -1) return null;
  const top = joined(texts.slice(0, at + 1));
  const bottom = joined(texts.slice(at + 1));
  if (top.length > rules.maxCharsPerLine || bottom.length > rules.maxCharsPerLine) return null;
  return [top, bottom];
}

/** Characters a second of a caption on screen for `seconds`, line breaks not counted. */
export const readingSpeed = (lines: readonly string[], seconds: number): number =>
  lines.join('').length / Math.max(1e-6, seconds);

/**
 * The timing rules, applied in order: lag-out, minimum duration, reading
 * speed, maximum duration, then the gaps.
 */
export function timeCues(input: readonly Cue[], rules: CaptionRules, fps: number): Cue[] {
  const gap = rules.gapFrames / fps;
  const cues = input.map((cue) => ({ ...cue, lines: [...cue.lines] }));
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    const latest = Math.min(nextStart - gap, cue.start + rules.maxSeconds);
    // Wanted: half a second after the words, at least the minimum, and
    // long enough to read at 17 characters a second. The last two are
    // counted in whole frames from the frame the caption starts on: put on
    // the timeline, a caption given exactly its reading time lost a frame
    // to rounding now and then, and was marked as too fast at 17.008.
    const chars = cue.lines.join('').length;
    const startFrame = Math.round(cue.start * fps);
    const framesFor = (seconds: number): number => (startFrame + Math.ceil(seconds * fps - 1e-6)) / fps;
    const wanted = Math.max(cue.end + rules.lagOut, framesFor(rules.minSeconds), framesFor(chars / rules.maxCps));
    cue.end = Math.max(cue.end, Math.min(wanted, latest));
    // A caption never swallows the start of the next one.
    if (cue.end > nextStart - gap) cue.end = Math.max(cue.start + 1 / fps, nextStart - gap);
  }
  // Gaps: 2 frames, or half a second or more.
  for (let i = 0; i + 1 < cues.length; i += 1) {
    const between = cues[i + 1].start - cues[i].end;
    if (between < rules.closeGapsUnder) cues[i].end = Math.max(cues[i].start + 1 / fps, cues[i + 1].start - gap);
  }
  return cues;
}

/** A caption's text, laid out again from its words. */
export function linesForWords(words: readonly string[], rules: CaptionRules, language: CaptionLanguage): string[] {
  return breakLines(words, rules, language) ?? breakLinesGreedy(words, rules.maxCharsPerLine);
}

/** Lines of at most `max` characters, as many as it takes: for text that does not fit the rules. */
export function breakLinesGreedy(words: readonly string[], max: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length > max && current !== '') {
      lines.push(current);
      current = word;
    } else current = candidate;
  }
  if (current !== '' || lines.length === 0) lines.push(current);
  return lines;
}

export interface CueCheck {
  charsPerLine: boolean;
  lines: boolean;
  readingSpeed: boolean;
  minDuration: boolean;
  maxDuration: boolean;
}

/** Which rules a caption keeps. `nextStart` is the next caption's start, for nothing here but the caller's gap check. */
export function checkCue(cue: Pick<Cue, 'start' | 'end' | 'lines'>, rules: CaptionRules): CueCheck {
  const seconds = cue.end - cue.start;
  const epsilon = 1e-6;
  return {
    charsPerLine: cue.lines.every((line) => line.length <= rules.maxCharsPerLine),
    lines: cue.lines.length <= rules.maxLines,
    readingSpeed: readingSpeed(cue.lines, seconds) <= rules.maxCps + epsilon,
    minDuration: seconds >= rules.minSeconds - epsilon,
    maxDuration: seconds <= rules.maxSeconds + epsilon,
  };
}

/* Editing ----------------------------------------------------------------------- */

/**
 * A caption's text with its lines laid out again by the rules, for when it
 * is typed into: one line while it fits, two at the best break, more only
 * when two cannot hold it.
 *
 * Only the spaces between words change (each becomes a space or a line
 * break), and what is typed after the last word is kept, so the caret of
 * whoever is typing stays where it was and a trailing space is not eaten.
 */
export function reflowText(text: string, rules: CaptionRules, language: CaptionLanguage): string {
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const tail = /\s*$/.exec(text.slice(lead.length))?.[0] ?? '';
  const body = text.slice(lead.length, text.length - tail.length);
  if (body === '') return text.replace(/\n/g, ' ');
  const lines = linesForWords(body.split(/\s+/), rules, language);
  return `${lead.replace(/\n/g, ' ')}${lines.join('\n')}${tail.replace(/\n/g, ' ')}`;
}

/** What is wrong with a caption, if anything. */
export interface CaptionIssues {
  /** More characters a second than can be read. */
  tooFast: boolean;
  /** On screen for less than the minimum. */
  tooShort: boolean;
  /** On screen for longer than the maximum. */
  tooLong: boolean;
  tooManyLines: boolean;
  lineTooLong: boolean;
}

export const NO_ISSUES: CaptionIssues = { tooFast: false, tooShort: false, tooLong: false, tooManyLines: false, lineTooLong: false };

export function captionIssues(text: string, seconds: number, rules: CaptionRules): CaptionIssues {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return NO_ISSUES;
  const epsilon = 1e-6;
  return {
    tooFast: readingSpeed(lines, seconds) > rules.maxCps + epsilon,
    tooShort: seconds < rules.minSeconds - epsilon,
    tooLong: seconds > rules.maxSeconds + epsilon,
    tooManyLines: lines.length > rules.maxLines,
    lineTooLong: lines.some((line) => line.length > rules.maxCharsPerLine),
  };
}

export const hasIssues = (issues: CaptionIssues): boolean =>
  issues.tooFast || issues.tooShort || issues.tooLong || issues.tooManyLines || issues.lineTooLong;

/** A caption as the timing fix sees it: frames on the timeline, and its text. */
export interface TimedCaption {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
}

/**
 * New end frames for captions whose timing can be put right without
 * touching anything that is not theirs to touch.
 *
 * Safe means: a start never moves (it is where the words begin), nothing is
 * ever shortened below what it needs, and a caption only grows into time no
 * other caption is using. Within that:
 *   - too short, or too fast to read: it stays up longer, as far as the
 *     next caption (less the 2-frame gap) and the 7-second limit allow;
 *   - a gap to the next one of less than half a second that is not 2
 *     frames: closed to 2 frames;
 *   - running into the next one: ended 2 frames before it.
 * A caption that is too long, or has too much text for its time even at
 * full stretch, is left for a person: that takes cutting it or its words.
 * Returns only the captions that change.
 */
export function fixTiming(captions: readonly TimedCaption[], rules: CaptionRules, fps: number): Map<string, number> {
  const out = new Map<string, number>();
  const row = [...captions].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  const maxFrames = Math.floor(rules.maxSeconds * fps + 1e-6);
  const minFrames = Math.ceil(rules.minSeconds * fps - 1e-6);
  const chainFrames = Math.round(rules.closeGapsUnder * fps);
  row.forEach((caption, index) => {
    const next = row[index + 1];
    const latest = next ? next.startFrame - rules.gapFrames : Infinity;
    const length = caption.endFrame - caption.startFrame;
    const chars = caption.text.replace(/\n/g, '').trim().length;
    const toRead = Math.ceil((chars / rules.maxCps) * fps - 1e-6);
    let end = caption.endFrame;
    // Longer, when it needs it and there is room - never past seven seconds.
    const wanted = Math.min(Math.max(length, minFrames, toRead), Math.max(length, maxFrames));
    end = Math.max(end, Math.min(caption.startFrame + wanted, latest));
    if (next) {
      const gap = next.startFrame - end;
      // Too close, or over the next one: 2 frames before it, if that leaves it a frame.
      if (gap < rules.gapFrames) end = Math.max(caption.startFrame + 1, latest);
      // Neither 2 frames nor half a second: chained, unless that makes it too long.
      else if (gap > rules.gapFrames && gap < chainFrames && latest - caption.startFrame <= maxFrames) end = latest;
    }
    if (end !== caption.endFrame && end > caption.startFrame) out.set(caption.id, end);
  });
  return out;
}
