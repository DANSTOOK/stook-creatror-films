import { spawn } from 'node:child_process';
import { TemplateTracker } from './tracker';

/**
 * Track a thing through a stretch of a file: ffmpeg decodes it small and grey
 * at `sampleFps`, piped straight in, and the tracker (tracker.ts) follows the
 * box from the first frame through each one after as it arrives - nothing is
 * written to disk, and a long stretch is never all in memory.
 */

export interface TrackRequest {
  fromSeconds: number;
  toSeconds: number;
  /** Frames a second to follow it at: the timeline's rate is plenty. */
  sampleFps: number;
  /** The thing on the first frame: centre and size, 0..1 of the picture. */
  box: { x: number; y: number; width: number; height: number };
  /** The file's picture size, for the small frames' shape. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface TrackSample {
  /** Seconds after `fromSeconds`. */
  t: number;
  /** Centre, 0..1 of the picture. */
  x: number;
  y: number;
  score: number;
}

const SMALL_WIDTH = 320;

export function trackArgs(path: string, request: TrackRequest, height: number): string[] {
  const from = Math.max(0, request.fromSeconds);
  const length = Math.max(0.05, request.toSeconds - from);
  return [
    '-hide_banner', '-v', 'error',
    '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', path,
    '-an',
    '-vf', `fps=${Math.max(1, Math.min(60, request.sampleFps))},scale=${SMALL_WIDTH}:${height},format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ];
}

export function runTrack(ffmpeg: string, path: string, request: TrackRequest, onProgress?: (done: number) => void): Promise<TrackSample[]> {
  const aspect = request.sourceHeight > 0 && request.sourceWidth > 0 ? request.sourceHeight / request.sourceWidth : 9 / 16;
  const height = Math.max(2, Math.round((SMALL_WIDTH * aspect) / 2) * 2);
  const frameBytes = SMALL_WIDTH * height;
  const fps = Math.max(1, Math.min(60, request.sampleFps));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, trackArgs(path, request, height), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const samples: TrackSample[] = [];
    let tracker: TemplateTracker | null = null;
    let pending: Buffer = Buffer.alloc(0);
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = new Uint8Array(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        const t = samples.length / fps;
        if (!tracker) {
          const box = request.box;
          tracker = new TemplateTracker(frame, SMALL_WIDTH, height, { x: box.x * SMALL_WIDTH, y: box.y * height, width: box.width * SMALL_WIDTH, height: box.height * height });
          samples.push({ t, x: box.x, y: box.y, score: 1 });
        } else {
          const point = tracker.next(frame);
          samples.push({ t, x: point.x / SMALL_WIDTH, y: point.y / height, score: point.score });
        }
        if (samples.length % 15 === 0) onProgress?.(samples.length);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (samples.length > 0) resolve(samples);
      else reject(new Error(errors.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited ${code}`));
    });
  });
}
