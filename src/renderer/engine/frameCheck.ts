/**
 * Which frame of a file a seeked <video> really shows, and whether it is the
 * one an exact render asked for.
 *
 * Chromium's <video> sometimes settles a seek on the wrong frame - the one
 * before, or the keyframe after - while `currentTime` and `readyState` say it
 * reached the target, and seeking to the same time again lands on the same
 * wrong frame. Measured on bar-coded files: 1-2 frames in 360 when exact
 * renders seek, 7-8 in 360 in a real export, every one next to a keyframe.
 * The readers (SequentialVideoReader) never do it, but a file WebCodecs
 * cannot read, or a reader whose decoder fails mid-export, has only the seek.
 *
 * The frame the element shows can be read - `new VideoFrame(video).timestamp`
 * is that frame's presentation time - and the file's frame times say which
 * frame it should be: the last one at or before the time asked for, the rule
 * the readers follow. The two together tell a right frame from a wrong one.
 */

/** Two timestamps closer than this name the same frame. */
const MAX_TOLERANCE_SECONDS = 0.0005;

/** The last frame starting at or before `seconds`; the first frame before that. */
export function ruleIndex(times: readonly number[], seconds: number): number {
  let low = 0;
  let high = times.length - 1;
  if (high < 0 || seconds + 1e-9 < times[0]) return 0;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (times[mid] <= seconds + 1e-9) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The frame whose time is within `tolerance` of `seconds`, or -1. */
export function nearestIndex(times: readonly number[], seconds: number, tolerance: number): number {
  if (times.length === 0) return -1;
  const at = ruleIndex(times, seconds);
  let best = -1;
  for (const index of [at - 1, at, at + 1]) {
    if (index < 0 || index >= times.length) continue;
    if (Math.abs(times[index] - seconds) <= tolerance && (best < 0 || Math.abs(times[index] - seconds) < Math.abs(times[best] - seconds))) best = index;
  }
  return best;
}

/**
 * How close a shown timestamp must be to a frame's: well under half the
 * shortest gap between frames, and never looser than half a millisecond -
 * containers round to a millisecond at worst, and the element to a
 * microsecond.
 */
export function toleranceFor(times: readonly number[]): number {
  let gap = Infinity;
  for (let index = 1; index < times.length; index += 1) gap = Math.min(gap, times[index] - times[index - 1]);
  return Math.min(MAX_TOLERANCE_SECONDS, gap / 4);
}

/**
 * A time well inside frame `index`: halfway to the next frame, or to `end`
 * for the last one. Aiming there, rather than near either edge, leaves the
 * player's rounding no frame boundary to fall across.
 */
export function middleOf(times: readonly number[], index: number, end: number): number {
  const start = times[index];
  const next = index + 1 < times.length ? times[index + 1] : Math.max(end, start + 1e-3);
  return start + (next - start) / 2;
}

export interface Verdict {
  /** The shown frame is the one the rule picks. */
  right: boolean;
  /** The frame the rule picks, by index. */
  expected: number;
  /** The frame shown, by index, or -1 when its timestamp names none. */
  shown: number;
}

/**
 * One file's frame times, and the clock its element counts them in.
 *
 * The element reports the container's own timestamps - measured equal on
 * MP4, MKV and WebM - but a player may count from a negative start time
 * instead, which shifts every timestamp by it. Such a file has two candidate
 * clocks; the first frame whose timestamp fits only one of them settles it.
 */
export class FrameCheck {
  readonly tolerance: number;
  private clock: number | null;

  constructor(
    /** Presentation times of the file's frames, in seconds, ascending. */
    readonly times: readonly number[],
    /** Offsets the element's clock may have from these times; 0 first. */
    private readonly clocks: readonly number[] = [0],
  ) {
    this.tolerance = toleranceFor(times);
    this.clock = clocks.length === 1 ? clocks[0] : null;
  }

  /** The offsets still in question: one, once the clock is known. */
  private get live(): readonly number[] {
    return this.clock === null ? this.clocks : [this.clock];
  }

  /** The frame the rule picks for `seconds` of the element's clock. */
  expectedAt(seconds: number): number {
    return ruleIndex(this.times, seconds - this.live[0]);
  }

  /**
   * Where to seek the element for the frame the rule picks at `seconds`: the
   * middle of that frame on its clock. Until the clock is known, `seconds`
   * itself, which is inside the right frame on either.
   */
  aimFor(seconds: number, end: number): number {
    if (this.clock === null) return seconds;
    return this.middle(this.expectedAt(seconds), end);
  }

  /** The middle of frame `index` on the element's clock (the likeliest one, until it is known). */
  middle(index: number, end: number): number {
    const clock = this.clock ?? this.clocks[0];
    const clamped = Math.max(0, Math.min(index, this.times.length - 1));
    return middleOf(this.times, clamped, end - clock) + clock;
  }

  /** Judge the frame showing `shownSeconds` against the rule at `seconds`. */
  judge(seconds: number, shownSeconds: number): Verdict {
    const readings = this.live.map((clock) => ({
      clock,
      expected: ruleIndex(this.times, seconds - clock),
      shown: nearestIndex(this.times, shownSeconds - clock, this.tolerance),
    }));
    const fitting = readings.filter((reading) => reading.shown >= 0);
    // A timestamp that fits one clock only settles which clock it is.
    if (this.clock === null && fitting.length === 1) this.clock = fitting[0].clock;
    const first = fitting[0] ?? readings[0];
    return {
      // Right only if every clock it could be on agrees it is right.
      right: fitting.length > 0 && fitting.every((reading) => reading.shown === reading.expected),
      expected: first.expected,
      shown: first.shown,
    };
  }
}
