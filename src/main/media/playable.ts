import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProgress, proxyKey } from './proxies';

/**
 * A copy of a video the editor's decoder can open, for a file it cannot.
 *
 * Chromium turns away files that every player opens: an MP4 from a phone or
 * a stock site whose first frames are timed before zero ("unfixable negative
 * timestamp"), an odd edit list. Such a file only needs its packets put in a
 * new box - a remux, seconds even for gigabytes, not a pixel changed. A file
 * in a codec the decoder has not got at all (ProRes, some HEVC) is turned
 * into H.264 instead, at a quality that does not show.
 *
 * The copy is what is decoded - in the viewer and in the export alike - and
 * the original stays what the project points at: its sound, scenes, mattes
 * and tracking are all still read from it by ffmpeg. Kept in the user's
 * folder under a name made of the file's path, size and time, like a proxy,
 * so reopening the project finds it again without redoing it.
 */

export type PlayableMode = 'remux' | 'transcode';

export function playableArgs(source: string, target: string, mode: PlayableMode): string[] {
  const common = ['-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-y'];
  if (mode === 'remux') {
    // The edit list is what puts the first frames before zero; without it they start at zero, as they play.
    return [...common, '-ignore_editlist', '1', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', target];
  }
  return [
    ...common,
    '-i', source,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    target,
  ];
}

export class PlayableStore {
  private readonly building = new Map<string, Promise<string | null>>();
  lastError: string | null = null;

  constructor(
    private readonly folder: string,
    private readonly ffmpeg: string,
  ) {}

  private async keyFor(path: string, mode: PlayableMode): Promise<string | null> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return `${proxyKey({ path, bytes: info.size, modifiedMs: info.mtimeMs })}-${mode}`;
  }

  /** The copy, made now or found from before; null when ffmpeg could not make one. */
  async make(path: string, mode: PlayableMode, totalSeconds: number, onProgress?: (fraction: number) => void): Promise<string | null> {
    const key = await this.keyFor(path, mode);
    if (!key) return null;
    const target = join(this.folder, `${key}.mp4`);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 0) return target;
    const already = this.building.get(key);
    if (already) return already;
    const run = this.encode(path, target, mode, totalSeconds, onProgress).finally(() => this.building.delete(key));
    this.building.set(key, run);
    return run;
  }

  private async encode(path: string, target: string, mode: PlayableMode, totalSeconds: number, onProgress?: (fraction: number) => void): Promise<string | null> {
    await mkdir(this.folder, { recursive: true });
    // Written under another name and renamed when whole: half a copy is never found and trusted.
    const temporary = target.replace(/\.mp4$/, `.building-${process.pid}.mp4`);
    const failure = await new Promise<string | null>((resolve) => {
      const child = spawn(this.ffmpeg, playableArgs(path, temporary, mode), { windowsHide: true });
      let pending = '';
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const fraction = parseProgress(line, totalSeconds);
          if (fraction !== null) onProgress?.(fraction);
        }
      });
      let complaint = '';
      child.stderr.on('data', (chunk: Buffer) => {
        complaint = `${complaint}${chunk.toString('utf8')}`.slice(-2000);
      });
      child.on('error', (error) => resolve(error.message));
      child.on('close', (code) => resolve(code === 0 ? null : complaint.trim().split(/\r?\n/).pop() || `ffmpeg exited ${code}`));
    });
    if (failure !== null) {
      await rm(temporary, { force: true });
      this.lastError = failure;
      return null;
    }
    await rename(temporary, target).catch(() => rm(temporary, { force: true }));
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return null;
    onProgress?.(1);
    return target;
  }
}
