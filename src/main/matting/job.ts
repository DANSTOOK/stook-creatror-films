import type { MatteModel } from './catalog';
import type { MatteDevice } from './device';

/**
 * What the main process and the matting worker say to each other. The worker
 * is an Electron utility process (worker.ts), one per analysis: a model that
 * runs out of GPU memory, or a driver that crashes, takes that process down
 * and not the editor.
 */

export interface MatteJob {
  ffmpeg: string;
  source: string;
  /** A still: one frame, no frame rate. */
  still: boolean;
  /**
   * The file's average frame rate, kept in the header for information and
   * used for the progress bar. Frames are not taken at it: each is taken at
   * its own time (matteFfmpegArgs).
   */
  fps: number;
  /** How many frames to expect, for the progress bar only. */
  expectedFrames: number;
  sourceWidth: number;
  sourceHeight: number;
  matteWidth: number;
  matteHeight: number;
  model: MatteModel;
  modelPath: string;
  /** Written here as it goes, renamed to `target` only when complete. */
  part: string;
  target: string;
  /** The device to use; null to measure and choose (device.ts). */
  device: MatteDevice | null;
  threads: number;
  /** Smooth the mattes over time (shared/matte/smoothing.ts); off only to measure what that does. */
  smoothing: boolean;
}

export type ToWorker = { type: 'start'; job: MatteJob } | { type: 'cancel' };

export type FromWorker =
  | { type: 'device'; device: MatteDevice; probe?: { cpuMs: number; gpus: Array<{ index: number; ms: number }> } }
  | { type: 'progress'; done: number; total: number; msPerFrame: number }
  /**
   * One more frame is on disk, whole, and its bytes end at `end`: the next
   * frame starts there. Sent only once the write has finished, so the page
   * can read every frame up to it from the temporary file while the rest is
   * still being made (mattingIpc.ts, mattesPartial). `time` is the frame's
   * presentation time, in seconds.
   */
  | { type: 'written'; end: number; time: number }
  | { type: 'done'; frames: number; bytes: number; msPerFrame: number; timings: { probeMs: number; loadMs: number; framesMs: number } }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

/**
 * ffmpeg's arguments to hand the worker every frame as raw RGB, already at
 * the size the model takes: scaling in ffmpeg is far cheaper than in
 * JavaScript.
 *
 * Every frame of the file, once, as it is (`-fps_mode passthrough`), with
 * its presentation time reported on stderr by `showinfo` (ShowinfoTimes).
 * Resampling to one rate - the file's average, as this used to - is fine
 * for a file with a constant rate and wrong for one without, a phone
 * recording or footage joined from different rates, as soon as the
 * timeline runs at any other rate: on a 30 fps timeline, 15% of the frames
 * of a file joined from 30, 60 and 20 fps had the matte of the frame before
 * or after, and 30% of a phone-like recording (.bench-tmp/matte-vfr.mjs).
 * Found by time instead (shared/matte/format.ts, matteFrameAt), none. `-copyts`
 * keeps the times as the file gives them, edit list applied, which is how
 * the renderer's own decoders time the pictures (engine/mp4.ts), rather than
 * moved by where the file's earliest stream - its audio, say - begins.
 *
 * `level+info` tags every line with its level, so ffmpeg's own complaints
 * can be told from showinfo's chatter.
 */
export function matteFfmpegArgs(source: string, size: { width: number; height: number }, still: boolean): string[] {
  const filters = [`scale=${size.width}:${size.height}:flags=bilinear`, 'format=rgb24', ...(still ? [] : ['showinfo'])];
  return [
    '-hide_banner', '-nostats', '-loglevel', 'level+info', '-nostdin', '-copyts',
    '-i', source, '-an', '-sn', '-dn', '-vf', filters.join(','), '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  ];
}

/**
 * Reads showinfo's lines as they come: the time base once, then for each
 * frame its number and timestamp. Times are worked out from the integer
 * timestamp and the time base, not from the printed seconds, which have six
 * significant digits - a hundredth of a second, twenty minutes in.
 */
export class ShowinfoTimes {
  readonly times: number[] = [];
  /**
   * The time base as its two integers. A timestamp is multiplied by the one
   * and divided by the other, never multiplied by a rounded 1/90000: that is
   * how engine/mp4.ts times a sample, and a frame that falls exactly on the
   * middle of a timeline frame must be judged the same way on both sides.
   */
  private timeBase: { num: number; den: number } | null = null;
  private pending = '';

  /** Feed stderr text; returns the whole lines that were not showinfo's (ffmpeg's own messages). */
  push(text: string): string[] {
    const lines = `${this.pending}${text}`.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    const others: string[] = [];
    for (const line of lines) if (!this.line(line)) others.push(line);
    return others;
  }

  /** True for a line of showinfo's. */
  private line(line: string): boolean {
    if (!line.includes('Parsed_showinfo')) return false;
    const base = /config in time_base: (\d+)\/(\d+)/.exec(line);
    if (base && Number(base[2]) > 0) this.timeBase = { num: Number(base[1]), den: Number(base[2]) };
    const frame = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s/.exec(line);
    if (frame && this.timeBase) this.times[Number(frame[1])] = (Number(frame[2]) * this.timeBase.num) / this.timeBase.den;
    return true;
  }
}
