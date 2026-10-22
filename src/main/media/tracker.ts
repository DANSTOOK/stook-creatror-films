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
 *
 * Its size is followed too: once found, the patch is tried a little larger
 * and a little smaller where it is, and kept at the size that matches
 * clearly better - so a thing coming closer, or going away, is followed at
 * the size it now is, and says how much it has grown.
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
  /** Its size now, against its size in the first frame. */
  scale: number;
}

/** A match worse than this is not taken: the thing is behind something, or gone. */
export const MIN_MATCH = 0.45;
/** A match better than this teaches the template a little of how the thing looks now. */
const LEARN_MATCH = 0.75;
const LEARN_RATE = 0.12;
/** The sizes tried each frame, against the size it was... */
const SCALE_STEPS = [1.03, 1.06, 1 / 1.03, 1 / 1.06];
/** ...and taken only when it matches this much better: a still thing must not breathe. */
const SCALE_GAIN = 0.003;
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;

interface Template {
  data: Float32Array;
  w: number;
  h: number;
  mean: number;
  /** Sum of squared deviations from the mean. */
  norm: number;
}

/** `src` (sw x sh) resampled to dw x dh, bilinear. */
function resample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

function described(data: Float32Array, w: number, h: number): Template {
  const n = w * h;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += data[i];
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i += 1) norm += (data[i] - mean) ** 2;
  return { data, w, h, mean, norm };
}

export class TemplateTracker {
  /** How the thing looks, at its size in the first frame - learnt a little from each good match. */
  private base: Float32Array;
  /**
   * How it looked in the first frame, never learnt into: what its size is
   * judged against. A template that learns comes to look like whatever size
   * it is matched at, and would never see the thing grow.
   */
  private readonly origin: Float32Array;
  private readonly w0: number;
  private readonly h0: number;
  /** The base at the size the thing is now: what each frame is searched with. */
  private work: Template;
  private scale = 1;
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
    this.w0 = Math.max(8, Math.min(width - 2, Math.round(box.width)));
    this.h0 = Math.max(8, Math.min(height - 2, Math.round(box.height)));
    this.cx = Math.min(width - this.w0 / 2 - 1, Math.max(this.w0 / 2, box.x));
    this.cy = Math.min(height - this.h0 / 2 - 1, Math.max(this.h0 / 2, box.y));
    this.base = this.patch(first, Math.round(this.cx - this.w0 / 2), Math.round(this.cy - this.h0 / 2), this.w0, this.h0);
    this.origin = Float32Array.from(this.base);
    this.work = described(this.base, this.w0, this.h0);
  }

  private patch(frame: Uint8Array, left: number, top: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const row = (top + y) * this.width + left;
      for (let x = 0; x < w; x += 1) out[y * w + x] = frame[row + x];
    }
    return out;
  }

  /** `source` (the base, or the origin) at `scale`, or null when that size does not fit the frame. */
  private atScale(scale: number, source: Float32Array = this.base): Template | null {
    const w = Math.round(this.w0 * scale);
    const h = Math.round(this.h0 * scale);
    if (w < 8 || h < 8 || w > this.width - 2 || h > this.height - 2) return null;
    if (w === this.w0 && h === this.h0) return described(source, w, h);
    return described(resample(source, this.w0, this.h0, w, h), w, h);
  }

  /** Normalised cross-correlation of `t` with the frame at (left, top). */
  private score(frame: Uint8Array, t: Template, left: number, top: number): number {
    let sum = 0;
    let sumSq = 0;
    let cross = 0;
    const n = t.w * t.h;
    for (let y = 0; y < t.h; y += 1) {
      const row = (top + y) * this.width + left;
      const trow = y * t.w;
      for (let x = 0; x < t.w; x += 1) {
        const value = frame[row + x];
        sum += value;
        sumSq += value * value;
        cross += value * (t.data[trow + x] - t.mean);
      }
    }
    const variance = sumSq - (sum * sum) / n;
    if (variance <= 1e-6 || t.norm <= 1e-6) return 0;
    return cross / Math.sqrt(variance * t.norm);
  }

  /** The best place for `t` within `radius` of (cx, cy), every `step` pixels. */
  private search(frame: Uint8Array, t: Template, cx: number, cy: number, radius: number, step: number, best: { left: number; top: number; score: number }) {
    const left0 = Math.round(cx - t.w / 2);
    const top0 = Math.round(cy - t.h / 2);
    const maxLeft = this.width - t.w;
    const maxTop = this.height - t.h;
    for (let dy = -radius; dy <= radius; dy += step) {
      const top = top0 + dy;
      if (top < 0 || top > maxTop) continue;
      for (let dx = -radius; dx <= radius; dx += step) {
        const left = left0 + dx;
        if (left < 0 || left > maxLeft) continue;
        const s = this.score(frame, t, left, top);
        if (s > best.score) {
          best.left = left;
          best.top = top;
          best.score = s;
        }
      }
    }
    return best;
  }

  /** Find the thing in the next frame. */
  next(frame: Uint8Array): TrackPoint {
    const t = this.work;
    const reach = Math.max(10, Math.round(Math.max(t.w, t.h) * 0.6));
    // Coarse every other pixel round where it should be, then every pixel round the best.
    const coarse = this.search(frame, t, this.cx + this.vx, this.cy + this.vy, reach, 2, { left: 0, top: 0, score: -2 });
    let found = this.search(frame, t, coarse.left + t.w / 2, coarse.top + t.h / 2, 2, 1, { ...coarse });
    if (found.score < MIN_MATCH) {
      // Lost for this frame: stay put, and stop guessing ahead.
      this.vx *= 0.5;
      this.vy *= 0.5;
      return { x: this.cx, y: this.cy, score: found.score, scale: this.scale };
    }
    let x = found.left + t.w / 2;
    let y = found.top + t.h / 2;

    // A little larger, a little smaller, where it is: the best of a few sizes, judged
    // against the first frame's look, and kept only when clearly better than the size
    // it was - a still thing must not breathe. The place is then found again at that size.
    const judged = this.atScale(this.scale, this.origin);
    if (judged) {
      const now = this.search(frame, judged, x, y, 2, 1, { left: 0, top: 0, score: -2 });
      let chosen: { scale: number; at: { left: number; top: number; score: number }; w: number; h: number } | null = null;
      for (const factor of SCALE_STEPS) {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
        if (scale === this.scale) continue;
        const tried = this.atScale(scale, this.origin);
        if (!tried || (tried.w === judged.w && tried.h === judged.h)) continue;
        const there = this.search(frame, tried, x, y, 3, 1, { left: 0, top: 0, score: -2 });
        if (there.score > (chosen?.at.score ?? now.score + SCALE_GAIN)) chosen = { scale, at: there, w: tried.w, h: tried.h };
      }
      if (chosen) {
        this.scale = chosen.scale;
        const resized = this.atScale(chosen.scale);
        if (resized) {
          this.work = resized;
          const cx = chosen.at.left + chosen.w / 2;
          const cy = chosen.at.top + chosen.h / 2;
          found = this.search(frame, resized, cx, cy, 2, 1, { left: 0, top: 0, score: -2 });
          x = found.left + resized.w / 2;
          y = found.top + resized.h / 2;
        }
      }
    }

    this.vx = 0.6 * this.vx + 0.4 * (x - this.cx);
    this.vy = 0.6 * this.vy + 0.4 * (y - this.cy);
    this.cx = x;
    this.cy = y;
    if (found.score > LEARN_MATCH) {
      // Learnt at the first frame's size, so the template never drifts in size itself.
      const w = this.work.w;
      const h = this.work.h;
      const seen = this.patch(frame, found.left, found.top, w, h);
      const asBase = w === this.w0 && h === this.h0 ? seen : resample(seen, w, h, this.w0, this.h0);
      for (let i = 0; i < asBase.length; i += 1) this.base[i] += (asBase[i] - this.base[i]) * LEARN_RATE;
      this.work = this.atScale(this.scale) ?? this.work;
    }
    return { x, y, score: found.score, scale: this.scale };
  }
}
