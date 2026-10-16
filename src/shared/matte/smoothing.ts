/**
 * Keeping a matte from flickering.
 *
 * The models look at one picture at a time, so a pixel the model is unsure
 * of can come and go from one frame to the next: a hole that opens in a fur
 * collar for a single frame, an edge that shimmers. The model with real
 * memory of earlier frames (RobustVideoMatting) is GPL and cannot ship, so
 * the steadiness is put back here, in two steps, after the model has run:
 *
 * 1. A median of three frames - the one before, this one, the one after -
 *    per pixel. A value that appears for one frame only is outvoted by its
 *    neighbours, however large the jump, and a pixel that is really moving
 *    (getting steadily brighter or darker) keeps its own value, because the
 *    median of a steady change is its middle. A cut is safe for the same
 *    reason: two of the three are always from the same shot.
 * 2. A light running average for the small jitter that remains, weighted by
 *    how close the new value is to the old: a small difference is noise and
 *    is evened out, a large one is movement and is followed at once, so an
 *    arm that moves does not leave a ghost behind it. A frame that differs
 *    from the last on average by more than a fifth is taken as a cut, and the
 *    average starts again from it.
 *
 * Mattes are computed ahead of time, so looking one frame ahead costs only a
 * frame of delay in the worker. tests/MatteSmoothing.test.ts and
 * tests/bench/matte-flicker.mjs measure what each step does.
 */

export interface SmoothingOptions {
  /** How much of the previous result a matching pixel keeps, 0..1. */
  strength: number;
  /** A change larger than this (0..1 of full scale) is movement, not noise. */
  tolerance: number;
  /** A frame whose mean change is larger than this (0..1) is a new shot. */
  cut: number;
}

export const DEFAULT_SMOOTHING: SmoothingOptions = { strength: 0.5, tolerance: 0.2, cut: 0.2 };

/** The per-pixel median of three frames. */
export function median3(before: Uint8Array, current: Uint8Array, after: Uint8Array, into = new Uint8Array(current.length)): Uint8Array {
  for (let index = 0; index < current.length; index += 1) {
    const a = before[index];
    const b = current[index];
    const c = after[index];
    into[index] = a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
  }
  return into;
}

/** Mean absolute difference of two frames, 0..1. */
export function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]);
  return a.length === 0 ? 0 : sum / (a.length * 255);
}

/**
 * The running average, in place on `current`, from the previous result.
 * Returns whether the frame was taken as a cut (and so left as it was).
 */
export function blendWithPrevious(previous: Uint8Array, current: Uint8Array, options: SmoothingOptions = DEFAULT_SMOOTHING): boolean {
  if (meanDifference(previous, current) > options.cut) return true;
  const tolerance = Math.max(1e-3, options.tolerance) * 255;
  for (let index = 0; index < current.length; index += 1) {
    const now = current[index];
    const was = previous[index];
    const distance = Math.abs(now - was);
    if (distance >= tolerance) continue;
    const weight = options.strength * (1 - distance / tolerance);
    current[index] = Math.round(now + weight * (was - now));
  }
  return false;
}

/**
 * Frames in, steadier frames out, one frame behind: `push` hands back the
 * smoothed frame before the one just pushed (null for the first), and
 * `finish` the last one. The arrays passed in are kept, not copied - the
 * caller hands over a new array for every frame.
 */
export class MatteSmoother {
  private before: Uint8Array | null = null;
  private current: Uint8Array | null = null;
  private previousOut: Uint8Array | null = null;

  private readonly options: SmoothingOptions;

  // A plain field rather than a parameter property: tests/bench/matte-flicker.mjs
  // loads this file with Node's own TypeScript stripping, which has no such thing.
  constructor(options: SmoothingOptions = DEFAULT_SMOOTHING) {
    this.options = options;
  }

  push(next: Uint8Array): Uint8Array | null {
    if (!this.current) {
      this.current = next;
      return null;
    }
    const out = this.smooth(this.before ?? this.current, this.current, next);
    this.before = this.current;
    this.current = next;
    return out;
  }

  /** The last frame, with only the frame before it to compare to. */
  finish(): Uint8Array | null {
    if (!this.current) return null;
    const out = this.smooth(this.before ?? this.current, this.current, this.current);
    this.before = null;
    this.current = null;
    this.previousOut = null;
    return out;
  }

  private smooth(before: Uint8Array, current: Uint8Array, after: Uint8Array): Uint8Array {
    const out = median3(before, current, after);
    if (this.previousOut) blendWithPrevious(this.previousOut, out, this.options);
    this.previousOut = out;
    return out;
  }
}

/* Measuring ----------------------------------------------------------------- */

/**
 * How much a sequence of mattes flickers: the share of pixels, per frame,
 * that jump by more than `threshold` (0..1) away from both neighbours in the
 * same direction - there one frame and gone the next. Steady movement is
 * not counted, since it moves away from one neighbour and towards the other.
 */
export function flickerRate(frames: readonly Uint8Array[], threshold = 0.25): number {
  if (frames.length < 3) return 0;
  const limit = threshold * 255;
  let flickering = 0;
  let total = 0;
  for (let index = 1; index < frames.length - 1; index += 1) {
    const [a, b, c] = [frames[index - 1], frames[index], frames[index + 1]];
    for (let pixel = 0; pixel < b.length; pixel += 1) {
      const up = b[pixel] - a[pixel] > limit && b[pixel] - c[pixel] > limit;
      const down = a[pixel] - b[pixel] > limit && c[pixel] - b[pixel] > limit;
      if (up || down) flickering += 1;
    }
    total += b.length;
  }
  return total === 0 ? 0 : flickering / total;
}

/** Mean frame-to-frame change over a sequence, 0..1: flicker and real movement together. */
export function temporalChange(frames: readonly Uint8Array[]): number {
  if (frames.length < 2) return 0;
  let sum = 0;
  for (let index = 1; index < frames.length; index += 1) sum += meanDifference(frames[index - 1], frames[index]);
  return sum / (frames.length - 1);
}
