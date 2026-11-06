/**
 * Best moments: finding the stretches of a long recording worth keeping.
 *
 * Built entirely out of analysis this app already does - where the sound goes
 * quiet (main/media/silence), where the shot changes (main/media/scenes) - so
 * nothing new is measured and nothing is downloaded. What is new is only the
 * judgement made of those signals.
 *
 * The judgement, stated plainly so it can be argued with:
 *
 *  - SPEECH is the thing. A stretch with talking in it beats a stretch
 *    without, because a person watching a tutorial or a vlog is listening.
 *  - A long silence ENDS a moment. Someone stopping to think is where an
 *    editor cuts, and it is the most reliable boundary a recording has.
 *  - A SHOT CHANGE also ends one, because whatever happens after it is a
 *    different thing being shown.
 *  - A moment must be LONG ENOUGH to make sense and SHORT ENOUGH to hold
 *    attention. Three seconds is not a point; ninety is not a highlight.
 *
 * What this deliberately does NOT claim: that it knows what is interesting.
 * It cannot. It finds where speech runs on without a break, which is where
 * someone is making a point - and it says so in those words rather than
 * promising to pick the good bits.
 */

export interface Silence {
  start: number;
  end: number;
}

export interface Highlight {
  /** Seconds into the file. */
  start: number;
  end: number;
  /** 0..1, for the order they are offered in. */
  score: number;
  /** How long the talking runs without a break, which is the whole of the score. */
  speaking: number;
}

export interface HighlightOptions {
  /** How long the file is, in seconds. */
  duration: number;
  /** Where it goes quiet, from detectSilences. */
  silences: Silence[];
  /** Where the shot changes, from detectScenes. Absent for audio. */
  cuts?: number[];
  /** Shortest moment worth offering. */
  minSeconds?: number;
  /** Longest; anything running past this is cut at the nearest break. */
  maxSeconds?: number;
  /** How many to offer. */
  count?: number;
}

export const MIN_HIGHLIGHT = 6;
export const MAX_HIGHLIGHT = 60;
export const DEFAULT_COUNT = 5;

/**
 * The stretches that are NOT silent: speech, in other words.
 *
 * A recording's silences are the gaps; what is between them is someone
 * talking. Taking the complement is both simpler and more reliable than
 * hunting for speech directly.
 */
export function speechRuns(silences: Silence[], duration: number): Silence[] {
  const sorted = [...silences]
    .filter((one) => Number.isFinite(one.start) && Number.isFinite(one.end) && one.end > one.start)
    .sort((a, b) => a.start - b.start);
  const runs: Silence[] = [];
  let at = 0;
  for (const quiet of sorted) {
    if (quiet.start > at) runs.push({ start: at, end: Math.min(quiet.start, duration) });
    at = Math.max(at, quiet.end);
  }
  if (at < duration) runs.push({ start: at, end: duration });
  return runs.filter((run) => run.end > run.start);
}

/** Cut a run at every shot change inside it: what follows a cut is a different thing. */
function splitAtCuts(run: Silence, cuts: number[]): Silence[] {
  const inside = cuts.filter((at) => at > run.start + 0.5 && at < run.end - 0.5).sort((a, b) => a - b);
  if (inside.length === 0) return [run];
  const pieces: Silence[] = [];
  let from = run.start;
  for (const at of inside) {
    pieces.push({ start: from, end: at });
    from = at;
  }
  pieces.push({ start: from, end: run.end });
  return pieces;
}

/** A run longer than the limit, broken into even pieces that each still make sense. */
function capLength(run: Silence, maxSeconds: number): Silence[] {
  const length = run.end - run.start;
  if (length <= maxSeconds) return [run];
  const pieces = Math.ceil(length / maxSeconds);
  const each = length / pieces;
  return Array.from({ length: pieces }, (_, index) => ({ start: run.start + index * each, end: run.start + (index + 1) * each }));
}

/**
 * The best moments of a recording, longest unbroken speech first.
 *
 * The score is simply how long the talking runs, scaled against the longest
 * run found. There is no cleverness in it on purpose: a score that weighed
 * loudness or cut rate would be inventing a notion of "interesting" that this
 * cannot actually measure, and dressing a guess up as a judgement.
 */
export function findHighlights({
  duration,
  silences,
  cuts = [],
  minSeconds = MIN_HIGHLIGHT,
  maxSeconds = MAX_HIGHLIGHT,
  count = DEFAULT_COUNT,
}: HighlightOptions): Highlight[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const floor = Math.max(1, minSeconds);
  const ceiling = Math.max(floor, maxSeconds);

  const pieces: Silence[] = [];
  for (const run of speechRuns(silences, duration)) {
    for (const piece of splitAtCuts(run, cuts)) {
      pieces.push(...capLength(piece, ceiling));
    }
  }

  const worth = pieces.filter((piece) => piece.end - piece.start >= floor);
  if (worth.length === 0) return [];
  const longest = Math.max(...worth.map((piece) => piece.end - piece.start));

  return worth
    .map((piece) => {
      const speaking = piece.end - piece.start;
      return { start: piece.start, end: piece.end, speaking, score: longest > 0 ? speaking / longest : 0 };
    })
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, Math.max(1, Math.floor(count)))
    // Offered in the order they happen, not in the order they scored: a list
    // that jumps about in time is hard to read against the timeline.
    .sort((a, b) => a.start - b.start);
}

/** How much of the recording the chosen moments add up to. */
export const totalSeconds = (highlights: Highlight[]): number =>
  highlights.reduce((total, one) => total + (one.end - one.start), 0);
