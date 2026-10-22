/**
 * Following a thing through a video: a patch of the first frame - the box
 * the person drew round it - looked for in each frame after, near where it
 * was in the one before (template matching by normalised cross-correlation,
 * as the planar and point trackers of editors began).
 *
 * Frames are small and grey (320 px wide; main/media/trackJob.ts decodes
 * them), which is plenty to follow something across a frame and keeps a
 * frame's search to a few milliseconds. The template takes in a little of
 * each good match, so a thing that turns or changes light slowly is still
 * found; a frame where nothing matches well keeps the last place and says so.
 */

export interface TrackBox {
  /** Centre and size in pixels of the small frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackPoint {
  /** Centre in pixels of the small frame. */
  x: number;
  y: number;
  /** How well it matched, -1..1; under MIN_MATCH the place was kept, not found. */
  score: number;
}

/** A match worse than this is not taken: the thing is behind something, or gone. */
export const MIN_MATCH = 0.45;
/** A match better than this teaches the template a little of how the thing looks now. */
const LEARN_MATCH = 0.75;
const LEARN_RATE = 0.12;

export class TemplateTracker {
  private template: Float32Array;
  private readonly tw: number;
  private readonly th: number;
  private cx: number;
  private cy: number;
  /** Where the last frames moved it, to search ahead of a thing that is moving. */
  private vx = 0;
  private vy = 0;

  constructor(
    first: Uint8Array,
    private readonly width: number,
    private readonly height: number,
    box: TrackBox,
  ) {
    this.tw = Math.max(8, Math.min(width - 2, Math.round(box.width)));
    this.th = Math.max(8, Math.min(height - 2, Math.round(box.height)));
    this.cx = Math.min(width - this.tw / 2 - 1, Math.max(this.tw / 2, box.x));
    this.cy = Math.min(height - this.th / 2 - 1, Math.max(this.th / 2, box.y));
    this.template = this.patch(first, Math.round(this.cx - this.tw / 2), Math.round(this.cy - this.th / 2));
  }

  private patch(frame: Uint8Array, left: number, top: number): Float32Array {
    const out = new Float32Array(this.tw * this.th);
    for (let y = 0; y < this.th; y += 1) {
      const row = (top + y) * this.width + left;
      for (let x = 0; x < this.tw; x += 1) out[y * this.tw + x] = frame[row + x];
    }
    return out;
  }

  /** Normalised cross-correlation of the template with the frame at (left, top). */
  private score(frame: Uint8Array, left: number, top: number, templateMean: number, templateNorm: number): number {
    let sum = 0;
    let sumSq = 0;
    let cross = 0;
    const n = this.tw * this.th;
    for (let y = 0; y < this.th; y += 1) {
      const row = (top + y) * this.width + left;
      const trow = y * this.tw;
      for (let x = 0; x < this.tw; x += 1) {
        const value = frame[row + x];
        sum += value;
        sumSq += value * value;
        cross += value * (this.template[trow + x] - templateMean);
      }
    }
    const variance = sumSq - (sum * sum) / n;
    if (variance <= 1e-6 || templateNorm <= 1e-6) return 0;
    return cross / Math.sqrt(variance * templateNorm);
  }

  /** Find the thing in the next frame. */
  next(frame: Uint8Array): TrackPoint {
    const n = this.tw * this.th;
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += this.template[i];
    mean /= n;
    let norm = 0;
    for (let i = 0; i < n; i += 1) norm += (this.template[i] - mean) ** 2;

    const reach = Math.max(10, Math.round(Math.max(this.tw, this.th) * 0.6));
    const guessX = this.cx + this.vx;
    const guessY = this.cy + this.vy;
    const minLeft = 0;
    const minTop = 0;
    const maxLeft = this.width - this.tw;
    const maxTop = this.height - this.th;
    const around = (cx: number, cy: number, radius: number, step: number, best: { left: number; top: number; score: number }) => {
      const left0 = Math.round(cx - this.tw / 2);
      const top0 = Math.round(cy - this.th / 2);
      for (let dy = -radius; dy <= radius; dy += step) {
        const top = top0 + dy;
        if (top < minTop || top > maxTop) continue;
        for (let dx = -radius; dx <= radius; dx += step) {
          const left = left0 + dx;
          if (left < minLeft || left > maxLeft) continue;
          const s = this.score(frame, left, top, mean, norm);
          if (s > best.score) {
            best.left = left;
            best.top = top;
            best.score = s;
          }
        }
      }
      return best;
    };
    // Coarse every other pixel round where it should be, then every pixel round the best.
    const coarse = around(guessX, guessY, reach, 2, { left: 0, top: 0, score: -2 });
    const fine = around(coarse.left + this.tw / 2, coarse.top + this.th / 2, 2, 1, { ...coarse });
    if (fine.score < MIN_MATCH) {
      // Lost for this frame: stay put, and stop guessing ahead.
      this.vx *= 0.5;
      this.vy *= 0.5;
      return { x: this.cx, y: this.cy, score: fine.score };
    }
    const x = fine.left + this.tw / 2;
    const y = fine.top + this.th / 2;
    this.vx = 0.6 * this.vx + 0.4 * (x - this.cx);
    this.vy = 0.6 * this.vy + 0.4 * (y - this.cy);
    this.cx = x;
    this.cy = y;
    if (fine.score > LEARN_MATCH) {
      const seen = this.patch(frame, fine.left, fine.top);
      for (let i = 0; i < n; i += 1) this.template[i] += (seen[i] - this.template[i]) * LEARN_RATE;
    }
    return { x, y, score: fine.score };
  }
}
