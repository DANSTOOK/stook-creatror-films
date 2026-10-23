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
 * Its size and its turn are followed too: once found, the patch is tried a
 * little larger and smaller, then turned a few degrees either way, where it
 * is, and kept at the pose that matches clearly better - so a thing coming
 * closer, or turning, is followed as it now is, and says how much it has
 * grown and turned. A turned patch is compared over the circle inside it:
 * its corners would bring in whatever is round the thing.
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
  /** How far it has turned since the first frame, in degrees, clockwise on screen. */
  angle: number;
}

/** A match worse than this is not taken: the thing is behind something, or gone. */
export const MIN_MATCH = 0.45;
/** A match better than this teaches the template a little of how the thing looks now. */
const LEARN_MATCH = 0.75;
const LEARN_RATE = 0.12;
/** The sizes tried each frame, against the size it was... */
const SCALE_STEPS = [1.03, 1.06, 1 / 1.03, 1 / 1.06];
/** ...the turns tried, in degrees... */
const ANGLE_STEPS = [2.5, 5, -2.5, -5];
/** ...and either taken only when it matches this much better: a still thing must not breathe. */
const POSE_GAIN = 0.003;
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;

interface Template {
  data: Float32Array;
  w: number;
  h: number;
  /** Which pixels count (a turned patch: the circle inside it); all of them when absent. */
  mask?: Uint8Array;
  mean: number;
  /** Sum of squared deviations from the mean, over the pixels that count. */
  norm: number;
}

/** `src` (sw x sh) at (x, y), bilinear, clamped to its edges. */
function sample(src: ArrayLike<number>, sw: number, sh: number, x: number, y: number): number {
  const sx = Math.min(sw - 1, Math.max(0, x));
  const sy = Math.min(sh - 1, Math.max(0, y));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const tx = sx - x0;
  const ty = sy - y0;
  const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
  const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function described(data: Float32Array, w: number, h: number, mask?: Uint8Array): Template {
  let count = 0;
  let mean = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (mask && !mask[i]) continue;
    mean += data[i];
    count += 1;
  }
  mean /= Math.max(1, count);
  let norm = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (mask && !mask[i]) continue;
    norm += (data[i] - mean) ** 2;
  }
  return { data, w, h, mean, norm, ...(mask ? { mask } : {}) };
}

export class TemplateTracker {
  /** How the thing looks, at its size and turn in the first frame - learnt a little from each good match. */
  private base: Float32Array;
  /**
   * How it looked in the first frame, never learnt into: what its size and
   * turn are judged against. A template that learns comes to look like
   * whatever pose it is matched at, and would never see the thing grow or turn.
   */
  private readonly origin: Float32Array;
  private readonly w0: number;
  private readonly h0: number;
  /** The base at the pose the thing is in now: what each frame is searched with. */
  private work: Template;
  private scale = 1;
  private angle = 0;
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
    const left = Math.round(this.cx - this.w0 / 2);
    const top = Math.round(this.cy - this.h0 / 2);
    this.base = new Float32Array(this.w0 * this.h0);
    for (let y = 0; y < this.h0; y += 1) {
      for (let x = 0; x < this.w0; x += 1) this.base[y * this.w0 + x] = first[(top + y) * width + left + x];
    }
    this.origin = Float32Array.from(this.base);
    this.work = described(this.base, this.w0, this.h0);
  }

  /**
   * `source` (the base, or the origin) as it looks grown by `scale` and turned
   * by `angle` degrees, or null when that does not fit the frame. Turned (or
   * when `circle` is asked for), only the circle inside it counts.
   */
  private posed(source: Float32Array, scale: number, angle: number, circle = false): Template | null {
    const w = Math.round(this.w0 * scale);
    const h = Math.round(this.h0 * scale);
    if (w < 8 || h < 8 || w > this.width - 2 || h > this.height - 2) return null;
    const turned = Math.abs(angle) > 1e-3;
    const masked = turned || circle;
    const data = new Float32Array(w * h);
    const mask = masked ? new Uint8Array(w * h) : undefined;
    const radians = (angle * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const radius = Math.min(w, h) / 2;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x + 0.5 - w / 2;
        const dy = y + 0.5 - h / 2;
        const i = y * w + x;
        if (mask) {
          if (dx * dx + dy * dy > radius * radius) continue;
          mask[i] = 1;
        }
        // Back from the frame to the first frame's patch: turned back, shrunk back.
        const bx = (cos * dx + sin * dy) / scale + this.w0 / 2 - 0.5;
        const by = (-sin * dx + cos * dy) / scale + this.h0 / 2 - 0.5;
        data[i] = sample(source, this.w0, this.h0, bx, by);
      }
    }
    return described(data, w, h, mask);
  }

  /** Normalised cross-correlation of `t` with the frame at (left, top). */
  private score(frame: Uint8Array, t: Template, left: number, top: number): number {
    let sum = 0;
    let sumSq = 0;
    let cross = 0;
    let n = 0;
    const mask = t.mask;
    for (let y = 0; y < t.h; y += 1) {
      const row = (top + y) * this.width + left;
      const trow = y * t.w;
      for (let x = 0; x < t.w; x += 1) {
        if (mask && !mask[trow + x]) continue;
        const value = frame[row + x];
        sum += value;
        sumSq += value * value;
        cross += value * (t.data[trow + x] - t.mean);
        n += 1;
      }
    }
    if (n === 0) return 0;
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

  /**
   * The best of `poses` at (x, y), judged against the first frame's look, when
   * it beats the pose it is in by POSE_GAIN; null otherwise.
   */
  private betterPose(frame: Uint8Array, x: number, y: number, poses: Array<{ scale: number; angle: number }>): { scale: number; angle: number; x: number; y: number } | null {
    const judged = this.posed(this.origin, this.scale, this.angle, true);
    if (!judged) return null;
    const now = this.search(frame, judged, x, y, 2, 1, { left: 0, top: 0, score: -2 });
    let chosen: { scale: number; angle: number; x: number; y: number; score: number } | null = null;
    for (const pose of poses) {
      const tried = this.posed(this.origin, pose.scale, pose.angle, true);
      if (!tried) continue;
      const there = this.search(frame, tried, x, y, 3, 1, { left: 0, top: 0, score: -2 });
      if (there.score > (chosen?.score ?? now.score + POSE_GAIN)) {
        chosen = { ...pose, x: there.left + tried.w / 2, y: there.top + tried.h / 2, score: there.score };
      }
    }
    return chosen;
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
      return { x: this.cx, y: this.cy, score: found.score, scale: this.scale, angle: this.angle };
    }
    let x = found.left + t.w / 2;
    let y = found.top + t.h / 2;

    // A little larger or smaller, then turned a little either way, where it is:
    // each kept only when clearly better. The place is then found again in that pose.
    const sized = this.betterPose(
      frame,
      x,
      y,
      SCALE_STEPS.map((factor) => ({ scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor)), angle: this.angle })).filter((pose) => pose.scale !== this.scale),
    );
    if (sized) ({ scale: this.scale, x, y } = sized);
    const turned = this.betterPose(frame, x, y, ANGLE_STEPS.map((step) => ({ scale: this.scale, angle: this.angle + step })));
    if (turned) ({ angle: this.angle, x, y } = turned);
    if (sized || turned) {
      const again = this.posed(this.base, this.scale, this.angle);
      if (again) {
        this.work = again;
        found = this.search(frame, again, x, y, 2, 1, { left: 0, top: 0, score: -2 });
        x = found.left + again.w / 2;
        y = found.top + again.h / 2;
      }
    }

    this.vx = 0.6 * this.vx + 0.4 * (x - this.cx);
    this.vy = 0.6 * this.vy + 0.4 * (y - this.cy);
    this.cx = x;
    this.cy = y;
    if (found.score > LEARN_MATCH) {
      // Learnt as the first frame's patch - turned back and shrunk back from where it was
      // found - so the template never drifts in size or turn itself.
      const radians = (this.angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      for (let by = 0; by < this.h0; by += 1) {
        for (let bx = 0; bx < this.w0; bx += 1) {
          const dx = (bx + 0.5 - this.w0 / 2) * this.scale;
          const dy = (by + 0.5 - this.h0 / 2) * this.scale;
          const fx = x + cos * dx - sin * dy - 0.5;
          const fy = y + sin * dx + cos * dy - 0.5;
          const i = by * this.w0 + bx;
          this.base[i] += (sample(frame, this.width, this.height, fx, fy) - this.base[i]) * LEARN_RATE;
        }
      }
      this.work = this.posed(this.base, this.scale, this.angle) ?? this.work;
    }
    return { x, y, score: found.score, scale: this.scale, angle: this.angle };
  }
}
