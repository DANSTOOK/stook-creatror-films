import { spawn } from 'node:child_process';

/**
 * Where the beats of a piece of music fall, for cutting to them - CapCut's
 * "Auto beat", Premiere's "Beat Edit".
 *
 * The sound is decoded mono at 22 050 Hz (here, by ffmpeg) and reduced to
 * an onset curve: how sharply the level rises, frame by frame (23 ms), in
 * the whole sound and in its highs (a kick and a hi-hat both count). The
 * tempo is the lag at which that curve best matches itself, between 60 and
 * 200 beats a minute, leaning towards the 120 most music sits near. The
 * beats are that grid, laid at the phase that catches the most onsets, each
 * then moved to the strongest onset close to it - so a song that drifts a
 * little is followed. Pure but for the decoding.
 */

export const BEAT_RATE = 22050;
const HOP = 512;
/** Seconds a frame of the onset curve is. */
export const FRAME_SECONDS = HOP / BEAT_RATE;

export interface BeatResult {
  bpm: number;
  /** Seconds from the start of the stretch analysed, ascending. */
  beats: number[];
  /** Which of `beats` start a bar (every fourth, at the phase that hits hardest). */
  downbeats: number[];
}

/** The onset curve of mono samples: per frame, how much the level (whole and highs) rose. */
export function onsetCurve(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const curve = new Float32Array(frames);
  let previousAll = 0;
  let previousHigh = 0;
  let last = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let all = 0;
    let high = 0;
    for (let i = frame * HOP; i < (frame + 1) * HOP; i += 1) {
      const value = samples[i];
      all += value * value;
      // The first difference: a crude high-pass, the clicks and the hats.
      const diff = value - last;
      high += diff * diff;
      last = value;
    }
    const logAll = Math.log10(all + 1e-9);
    const logHigh = Math.log10(high + 1e-9);
    // The level of the whole carries the beat (the kick); the highs only add to it (the hats come between).
    curve[frame] = Math.max(0, logAll - previousAll) + 0.25 * Math.max(0, logHigh - previousHigh);
    previousAll = logAll;
    previousHigh = logHigh;
  }
  // Made zero-mean above its own average, so a loud passage does not count as all onset.
  let mean = 0;
  for (const value of curve) mean += value;
  mean /= Math.max(1, curve.length);
  for (let i = 0; i < curve.length; i += 1) curve[i] = Math.max(0, curve[i] - mean);
  // Softened over a few frames: a beat is seldom a whole number of frames long, and a curve of
  // single-frame spikes matched itself better at two beats than at one, half a frame out.
  const kernel = [0.25, 0.5, 1, 0.5, 0.25];
  const soft = new Float32Array(curve.length);
  for (let i = 0; i < curve.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k += 1) sum += (curve[i + k - 2] ?? 0) * kernel[k];
    soft[i] = sum / 2.5;
  }
  return soft;
}

/** The tempo of an onset curve, in beats a minute, 60..200 - leaning towards 120. */
export function tempoOf(curve: Float32Array): { bpm: number; lag: number } {
  const minLag = Math.round(60 / 200 / FRAME_SECONDS);
  const maxLag = Math.round(60 / 60 / FRAME_SECONDS);
  const at = (lag: number): number => {
    let sum = 0;
    for (let i = lag; i < curve.length; i += 1) sum += curve[i] * curve[i - lag];
    return sum / Math.max(1, curve.length - lag);
  };
  let best = { lag: Math.round(60 / 120 / FRAME_SECONDS), score: -Infinity };
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const sum = at(lag);
    const bpm = 60 / (lag * FRAME_SECONDS);
    // A gentle preference for the tempo most music is near, so a beat is not taken for half or twice itself.
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const score = sum * weight;
    if (score > best.score) best = { lag, score };
  }
  const [a, b, c] = [at(best.lag - 1), at(best.lag), at(best.lag + 1)];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const lag = best.lag + Math.max(-0.5, Math.min(0.5, shift));
  return { bpm: 60 / (lag * FRAME_SECONDS), lag };
}

/** The beats of an onset curve at `lag` frames apart, in frames. */
export function beatFrames(curve: Float32Array, lag: number): number[] {
  if (curve.length === 0 || lag <= 0) return [];
  // The phase that catches the most onsets.
  let phase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < Math.ceil(lag); p += 1) {
    let score = 0;
    for (let at = p; at < curve.length; at += lag) score += curve[Math.round(at)] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      phase = p;
    }
  }
  // Along the grid, each beat drawn to the strongest onset within a tenth of a beat.
  const reach = Math.max(1, Math.round(lag * 0.1));
  const beats: number[] = [];
  let expected = phase;
  while (expected < curve.length) {
    const centre = Math.round(expected);
    let bestAt = centre;
    for (let at = Math.max(0, centre - reach); at <= Math.min(curve.length - 1, centre + reach); at += 1) {
      if (curve[at] > curve[bestAt]) bestAt = at;
    }
    beats.push(bestAt);
    // The next one from where this one really was: a drifting song is followed.
    expected = bestAt + lag;
  }
  return beats;
}

/** Of `beats` (frames), every fourth from the phase whose beats hit hardest: the starts of the bars. */
export function downbeatsOf(curve: Float32Array, beats: readonly number[]): number[] {
  let phase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < 4; p += 1) {
    let score = 0;
    for (let i = p; i < beats.length; i += 4) score += curve[beats[i]] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      phase = p;
    }
  }
  return beats.filter((_, index) => index % 4 === phase);
}

export function analyseBeats(samples: Float32Array): BeatResult {
  const curve = onsetCurve(samples);
  const { bpm, lag } = tempoOf(curve);
  const beats = beatFrames(curve, lag);
  const toSeconds = (frame: number): number => Math.round((frame * HOP + HOP / 2) / BEAT_RATE * 1000) / 1000;
  return { bpm: Math.round(bpm * 10) / 10, beats: beats.map(toSeconds), downbeats: downbeatsOf(curve, beats).map(toSeconds) };
}

/** The stretch `from`..`to` seconds of a file's sound, mono at BEAT_RATE, then its beats. */
export function detectBeats(ffmpeg: string, path: string, fromSeconds: number, toSeconds: number): Promise<BeatResult> {
  return new Promise((resolve, reject) => {
    const length = Math.max(0.5, toSeconds - fromSeconds);
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-v', 'error', '-ss', Math.max(0, fromSeconds).toFixed(3), '-t', length.toFixed(3), '-i', path, '-vn', '-ac', '1', '-ar', String(BEAT_RATE), '-f', 'f32le', 'pipe:1'],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', () => {
      const bytes = Buffer.concat(chunks);
      const usable = bytes.length - (bytes.length % 4);
      if (usable === 0) {
        reject(new Error('no sound'));
        return;
      }
      const copy = Buffer.from(bytes.subarray(0, usable));
      resolve(analyseBeats(new Float32Array(copy.buffer, copy.byteOffset, usable / 4)));
    });
  });
}
