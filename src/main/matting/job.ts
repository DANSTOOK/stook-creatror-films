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
  /** The rate frames are taken at: the file's own. */
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
   * still being made (mattingIpc.ts, mattesPartial).
   */
  | { type: 'written'; end: number }
  | { type: 'done'; frames: number; bytes: number; msPerFrame: number; timings: { probeMs: number; loadMs: number; framesMs: number } }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

/**
 * ffmpeg's arguments to hand the worker every frame as raw RGB, already at
 * the size the model takes: scaling in ffmpeg is far cheaper than in
 * JavaScript. The frame rate is fixed to the file's own (`fps`), so a file
 * with a variable rate still gives one picture per frame of the timeline's
 * clock, the picture that is on screen at that moment.
 */
export function matteFfmpegArgs(source: string, size: { width: number; height: number }, fps: number, still: boolean): string[] {
  const filters = [...(still ? [] : [`fps=${Number(fps.toFixed(6))}`]), `scale=${size.width}:${size.height}:flags=bilinear`, 'format=rgb24'];
  return ['-v', 'error', '-nostdin', '-i', source, '-an', '-sn', '-dn', '-vf', filters.join(','), '-f', 'rawvideo', 'pipe:1'];
}
