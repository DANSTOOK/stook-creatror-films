import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Proxies: small stand-ins for footage too heavy to edit.
 *
 * A 4K clip decodes at a few frames a second on a laptop, so scrubbing it is
 * guesswork. Every editor answers this the same way - cut against a small
 * version, render from the original - and so does this: a proxy is a 960-pixel
 * H.264 copy with short keyframe gaps, which is what makes scrubbing land
 * quickly, and **nothing outside the preview ever looks at it**. The export
 * reads the original file, always.
 *
 * Deliberate choices:
 *
 * - **No audio in a proxy.** Sound already plays from the original, decoding
 *   audio is not what makes a 4K timeline crawl, and a second copy of it is a
 *   second chance to drift out of sync.
 * - **Keyed by the file's path, size and time.** Re-render a clip in another
 *   program, keep the name, and the old proxy would be a picture of something
 *   that no longer exists. Changing any of the three builds a new one.
 * - **Never bigger than the source.** A proxy of a phone clip that is already
 *   small would cost time and give nothing back, so small footage keeps its
 *   own size and simply re-encodes short keyframe gaps.
 */

/** The long edge of a proxy, in pixels. Quarter-size for 4K, half for 1080p. */
export const PROXY_LONG_EDGE = 960;

/** Footage at least this wide is worth a proxy; below it, decoding is not the problem. */
export const PROXY_WORTH_IT_WIDTH = 1920;

export interface SourceStamp {
  path: string;
  bytes: number;
  modifiedMs: number;
}

/**
 * A name for this exact file at this exact moment.
 *
 * Path, size and modification time, so the same file always finds its proxy
 * and a changed file never finds a stale one.
 */
export function proxyKey(stamp: SourceStamp): string {
  const text = `${stamp.path.replace(/\\/g, '/').toLowerCase()}|${stamp.bytes}|${Math.round(stamp.modifiedMs)}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // A second pass over the length keeps two paths that differ only far apart
  // from colliding as easily as one round of FNV would.
  let tail = 5381;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    tail = Math.imul(tail, 33) ^ text.charCodeAt(index);
  }
  return `${(hash >>> 0).toString(36)}-${(tail >>> 0).toString(36)}`;
}

export function proxyFileName(key: string): string {
  return `${key}.mp4`;
}

/** Whether a proxy would buy anything for footage this size. */
export function worthProxying(width: number, height: number): boolean {
  return Math.max(width, height) >= PROXY_WORTH_IT_WIDTH;
}

/**
 * The size a proxy is made at: the long edge brought down to 960, keeping the
 * shape, both sides even because H.264 cannot encode an odd one, and never
 * larger than the source.
 */
export function proxySize(width: number, height: number, longEdge = PROXY_LONG_EDGE): { width: number; height: number } {
  const even = (value: number): number => Math.max(2, Math.round(value) - (Math.round(value) % 2));
  if (width <= 0 || height <= 0) return { width: 2, height: 2 };

  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width: even(width), height: even(height) };

  const scale = longEdge / longest;
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * ffmpeg's arguments for one proxy.
 *
 * `-g 30` is the point of the whole thing: a long-GOP camera file has to
 * decode seconds of video to show one frame in the middle, and a proxy with a
 * keyframe every second does not.
 */
export function proxyArgs(source: string, target: string, size: { width: number; height: number }): string[] {
  return [
    '-v', 'error',
    '-progress', 'pipe:1',
    '-nostats',
    '-y',
    '-i', source,
    '-an',
    '-vf', `scale=${size.width}:${size.height}:flags=bicubic`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-g', '30',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    target,
  ];
}

/**
 * How far along a proxy is, from ffmpeg's own progress lines.
 *
 * `out_time_us` is microseconds of finished output. Returns null for a line
 * that says nothing about progress, so the caller can ignore it.
 */
export function parseProgress(line: string, totalSeconds: number): number | null {
  const match = /^out_time_(us|ms)=(-?\d+)$/.exec(line.trim());
  if (!match || totalSeconds <= 0) return null;
  const seconds = Number(match[2]) / (match[1] === 'us' ? 1_000_000 : 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.max(0, Math.min(1, seconds / totalSeconds));
}

export interface ProxyRecord {
  key: string;
  file: string;
  bytes: number;
}

export type ProxyProgress = (fraction: number) => void;

export class ProxyStore {
  /** Builds in flight, by key, so asking twice for the same proxy waits once. */
  private readonly building = new Map<string, Promise<ProxyRecord | null>>();

  /** Running ffmpeg processes, so they can be stopped. */
  private readonly running = new Map<string, () => void>();

  /** Why the last build failed, for the interface to repeat rather than shrug. */
  lastError: string | null = null;

  constructor(
    private readonly folder: string,
    private readonly ffmpeg: string,
  ) {}

  fileFor(key: string): string {
    return join(this.folder, proxyFileName(key));
  }

  async stampFor(path: string): Promise<SourceStamp | null> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return { path, bytes: info.size, modifiedMs: info.mtimeMs };
  }

  /** The proxy this file already has, or null. */
  async find(path: string): Promise<ProxyRecord | null> {
    const stamp = await this.stampFor(path);
    if (!stamp) return null;
    const key = proxyKey(stamp);
    const file = this.fileFor(key);
    const info = await stat(file).catch(() => null);
    return info?.isFile() && info.size > 0 ? { key, file, bytes: info.size } : null;
  }

  /**
   * Build one, or hand back the one that is already there.
   *
   * Written to a temporary name and renamed at the end, so an interrupted
   * build cannot leave half a proxy to be found and trusted later.
   */
  async build(
    path: string,
    size: { width: number; height: number },
    totalSeconds: number,
    onProgress?: ProxyProgress,
  ): Promise<ProxyRecord | null> {
    const existing = await this.find(path);
    if (existing) return existing;

    const stamp = await this.stampFor(path);
    if (!stamp) return null;
    const key = proxyKey(stamp);

    const already = this.building.get(key);
    if (already) return already;

    const run = this.encode(key, path, size, totalSeconds, onProgress).finally(() => {
      this.building.delete(key);
      this.running.delete(key);
    });
    this.building.set(key, run);
    return run;
  }

  private async encode(
    key: string,
    path: string,
    size: { width: number; height: number },
    totalSeconds: number,
    onProgress?: ProxyProgress,
  ): Promise<ProxyRecord | null> {
    await mkdir(this.folder, { recursive: true });
    const target = this.fileFor(key);
    // The extension stays .mp4: ffmpeg picks the container from it, and a
    // temporary called ".mp4.building-1234" is "Invalid argument" to it.
    const temporary = join(this.folder, `${key}.building-${process.pid}.mp4`);

    const done = await new Promise<string | null>((resolve) => {
      const child = spawn(this.ffmpeg, proxyArgs(path, temporary, size), { windowsHide: true });
      this.running.set(key, () => child.kill());

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

      // Kept so a failure can say what went wrong. A proxy that silently does
      // not appear is the worst of both worlds: the editor stays slow and
      // nobody knows why.
      let complaint = '';
      child.stderr.on('data', (chunk: Buffer) => {
        complaint = `${complaint}${chunk.toString('utf8')}`.slice(-2000);
      });

      child.on('error', (error) => resolve(`could not start the encoder: ${error.message}`));
      child.on('close', (code) => {
        if (code === 0) resolve(null);
        else resolve(complaint.trim().split(/\r?\n/).pop() || `the encoder stopped with code ${code}`);
      });
    });

    if (done !== null) {
      await rm(temporary, { force: true });
      this.lastError = done;
      return null;
    }

    const { rename } = await import('node:fs/promises');
    await rename(temporary, target).catch(async () => {
      await rm(temporary, { force: true });
    });
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return null;
    onProgress?.(1);
    return { key, file: target, bytes: info.size };
  }

  /** Stop a build in progress. The half-written file goes with it. */
  cancel(key?: string): void {
    for (const [running, kill] of this.running) {
      if (key === undefined || running === key) kill();
    }
  }

  /** Every proxy kept, for showing how much room they take. */
  async list(): Promise<ProxyRecord[]> {
    const names = await readdir(this.folder).catch(() => []);
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.mp4'))
        .map(async (name) => {
          const file = join(this.folder, name);
          const info = await stat(file).catch(() => null);
          return info?.isFile() ? { key: name.replace(/\.mp4$/, ''), file, bytes: info.size } : null;
        }),
    );
    return records.filter((record): record is ProxyRecord => record !== null);
  }

  /** Throw them all away; they are rebuilt on demand. */
  async clear(): Promise<number> {
    const records = await this.list();
    await Promise.all(records.map((record) => rm(record.file, { force: true })));
    return records.length;
  }
}
