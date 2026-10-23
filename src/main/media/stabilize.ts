import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { proxyKey } from './proxies';

/**
 * Stabilizing a shaky video - a phone held in the hand, a walk - with
 * ffmpeg's vid.stab, in its two passes: vidstabdetect follows how each frame
 * moved against the one before, and vidstabtransform takes out the shake
 * while keeping the intended moves (a pan stays a pan), smoothed over
 * `smoothing` frames either side, and zooms in just enough that no edge
 * shows. A light sharpen after it, as Premiere's Warp Stabilizer and
 * Resolve's stabilizer leave the picture a touch softer for the zoom.
 *
 * Made once a file and strength and kept, like a proxy; the editor shows and
 * exports it in the file's place (renderer/media/stabilizeRun.ts). The sound
 * is copied across untouched.
 */

export type StabilizeStrength = 'light' | 'medium' | 'strong';

/** Frames smoothed over either side, and how much shake is looked for, at each strength. */
export const STABILIZE: Record<StabilizeStrength, { smoothing: number; shakiness: number }> = {
  light: { smoothing: 8, shakiness: 4 },
  medium: { smoothing: 18, shakiness: 6 },
  strong: { smoothing: 35, shakiness: 9 },
};

/** The two passes' arguments. `transforms` is a file name in the working folder: a Windows path's colon would end the filter's option. */
export function stabilizeArgs(source: string, target: string, strength: StabilizeStrength, transforms: string): { detect: string[]; transform: string[] } {
  const { smoothing, shakiness } = STABILIZE[strength];
  return {
    detect: ['-hide_banner', '-v', 'error', '-stats', '-y', '-i', source, '-map', '0:v:0', '-vf', `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${transforms}`, '-f', 'null', '-'],
    transform: [
      '-hide_banner', '-v', 'error', '-stats', '-y',
      '-i', source,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `vidstabtransform=input=${transforms}:smoothing=${smoothing}:optzoom=1:zoomspeed=0.25:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
      // Every frame where it was: the editor's frame times are the file's.
      '-fps_mode', 'passthrough',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      target,
    ],
  };
}

/** Seconds reached, from ffmpeg's -stats line ("time=00:01:02.50"). */
export function statsSeconds(line: string): number | null {
  const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function run(ffmpeg: string, args: string[], cwd: string, onSeconds: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd, windowsHide: true });
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      const seconds = statsSeconds(chunk.split('\r').filter(Boolean).pop() ?? '');
      if (seconds !== null) onSeconds(seconds);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').pop() || `ffmpeg ${code}`))));
  });
}

export class StabilizeStore {
  private readonly building = new Map<string, Promise<string>>();

  constructor(
    private readonly folder: string,
    private readonly ffmpeg: string,
  ) {}

  /** `path` stabilized at `strength`: found from before, or made now. `onProgress` gets 0..1 across both passes. */
  async make(path: string, strength: StabilizeStrength, durationSeconds: number, onProgress: (fraction: number) => void = () => undefined): Promise<string> {
    const info = await stat(path);
    const key = `${proxyKey({ path, bytes: info.size, modifiedMs: info.mtimeMs })}-${strength}`;
    const target = join(this.folder, `${key}.mp4`);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 0) return target;
    const already = this.building.get(key);
    if (already) return already;
    const job = (async () => {
      await mkdir(this.folder, { recursive: true });
      const transforms = `${key}-${process.pid}.trf`;
      const temporary = target.replace(/\.mp4$/, `.building-${process.pid}.mp4`);
      const share = (from: number, to: number) => (seconds: number) =>
        onProgress(Math.min(1, from + (to - from) * (durationSeconds > 0 ? Math.min(1, seconds / durationSeconds) : 0)));
      try {
        const args = stabilizeArgs(path, temporary, strength, transforms);
        // The detect pass reads only: about a third of the time; encoding is the rest.
        await run(this.ffmpeg, args.detect, this.folder, share(0, 0.35));
        await run(this.ffmpeg, args.transform, this.folder, share(0.35, 1)).catch(() =>
          // A sound an MP4 cannot hold as it is (PCM from a camera's MOV): AAC instead.
          run(this.ffmpeg, args.transform.map((arg, index, all) => (all[index - 1] === '-c:a' ? 'aac' : arg)).flatMap((arg) => (arg === 'aac' ? ['aac', '-b:a', '256k'] : [arg])), this.folder, share(0.35, 1)),
        );
        await rename(temporary, target);
        onProgress(1);
        return target;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      } finally {
        await rm(join(this.folder, transforms), { force: true });
      }
    })().finally(() => this.building.delete(key));
    this.building.set(key, job);
    return job;
  }
}
