import { spawn } from 'node:child_process';

/**
 * Lining up angles by their sound, for multicam: several cameras that heard
 * the same room. Each file's sound becomes an onset curve - how much louder
 * each hundredth of a second is than the one before - and the curves are
 * cross-correlated (by FFT, so an hour is as quick as a minute): where they
 * agree best is how far one started after the other. Claps, speech and
 * music all line up; the levels and the microphones need not match.
 */

/** The sound is read at this rate, mono. */
export const SYNC_RATE = 8000;
/** Onset curve frames a second: a hundredth of a second, under a frame at 60 fps. */
export const SYNC_FRAMES_PER_SECOND = 100;
const HOP = SYNC_RATE / SYNC_FRAMES_PER_SECOND;

/** How much louder each hop is than the one before it, in log energy: an onset curve. */
export function onsetCurveOf(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let i = frame * HOP; i < (frame + 1) * HOP; i += 1) sum += samples[i] * samples[i];
    energy[frame] = Math.log10(1e-9 + sum / HOP);
  }
  const curve = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) curve[frame] = Math.max(0, energy[frame] - energy[frame - 1]);
  // Zero mean, so silence on both sides is not counted as agreement.
  let mean = 0;
  for (const value of curve) mean += value;
  mean /= Math.max(1, frames);
  for (let frame = 0; frame < frames; frame += 1) curve[frame] -= mean;
  return curve;
}

/** In-place radix-2 FFT (inverse with `inverse`); lengths are powers of two. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export interface Alignment {
  /** Seconds into `other` at which `master`'s first moment is heard: positive when `other` started first. */
  seconds: number;
  /** How sure: the best agreement over the typical one (about 1 when nothing matched; clear matches are many times that). */
  confidence: number;
}

/** Where `other`'s onset curve agrees best with `master`'s. */
export function alignCurves(master: Float32Array, other: Float32Array): Alignment {
  let size = 1;
  while (size < master.length + other.length) size <<= 1;
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(master);
  bRe.set(other);
  fft(aRe, aIm, false);
  fft(bRe, bIm, false);
  // other ⋆ master: peaks at the lag where other[t + lag] matches master[t].
  for (let i = 0; i < size; i += 1) {
    const re = bRe[i] * aRe[i] + bIm[i] * aIm[i];
    const im = bIm[i] * aRe[i] - bRe[i] * aIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  fft(aRe, aIm, true);
  let best = 0;
  let bestValue = -Infinity;
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    const lag = i < size / 2 ? i : i - size;
    // Only lags at which the two overlap at all.
    if (lag <= -master.length || lag >= other.length) continue;
    total += Math.abs(aRe[i]);
    if (aRe[i] > bestValue) {
      bestValue = aRe[i];
      best = lag;
    }
  }
  const typical = total / Math.max(1, master.length + other.length - 1);
  return { seconds: best / SYNC_FRAMES_PER_SECOND, confidence: typical > 0 ? bestValue / typical : 0 };
}

/** A file's sound, mono at SYNC_RATE: the first `seconds` of it. */
function readSound(ffmpeg: string, path: string, seconds: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-t', seconds.toFixed(3), '-i', path, '-vn', '-ac', '1', '-ar', String(SYNC_RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', () => {
      const bytes = Buffer.concat(chunks);
      const usable = bytes.length - (bytes.length % 4);
      const copy = Buffer.from(bytes.subarray(0, usable));
      resolve(new Float32Array(copy.buffer, copy.byteOffset, usable / 4));
    });
  });
}

/**
 * Each of `paths` lined up with the first by sound: the seconds into each at
 * which the first one's start is heard (0 for the first; null for one with
 * no sound to go by). At most `seconds` of each is listened to.
 */
export async function alignBySound(ffmpeg: string, paths: readonly string[], seconds = 1200): Promise<(Alignment | null)[]> {
  const curves = await Promise.all(paths.map((path) => readSound(ffmpeg, path, seconds).then(onsetCurveOf).catch(() => null)));
  const master = curves[0];
  return curves.map((curve, index) => {
    if (index === 0) return { seconds: 0, confidence: Infinity };
    if (!master || !curve || master.length < SYNC_FRAMES_PER_SECOND || curve.length < SYNC_FRAMES_PER_SECOND) return null;
    return alignCurves(master, curve);
  });
}
