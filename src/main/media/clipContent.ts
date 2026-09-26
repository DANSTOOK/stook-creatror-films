import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';
import { proxyKey, type SourceStamp } from './proxies';

/**
 * What a clip shows on the timeline: a filmstrip of its pictures and the peaks
 * of its sound, made once per file and kept on disk.
 *
 * Both used to be missing or made in the page. The waveform was measured by
 * decoding the whole file in the renderer - the thread that also draws the
 * timeline and runs playback - and thrown away with the session. Here ffmpeg
 * does the work, in this process's children, one job at a time, at a lower
 * priority than the editor, and never while an export is running. The page
 * only ever reads the finished files.
 *
 * Keyed like the proxies (path, size and modification time), so a file that
 * changes gets new pictures and a file that does not is never measured twice,
 * in this session or the next.
 */

/** Bump when the format of either file changes: older caches are then ignored. */
const FORMAT_VERSION = 1;

/** Filmstrip frames are this tall. Clips draw them at up to 52 CSS px, 1.5x on most laptops. */
export const THUMB_HEIGHT = 72;

/** Most frames kept for one file: enough for a filmstrip at any zoom that shows the whole clip. */
export const MAX_THUMBS = 240;

/** Up to this long, every frame is decoded to choose from; longer, keyframes only. */
export const FULL_DECODE_SECONDS = 180;

/** Sound is measured at this rate: plenty for a picture of it, a third of the data of 48 kHz. */
export const PEAK_SAMPLE_RATE = 16_000;

/** Waveform resolution: min/max pairs per second of sound. */
export const PEAKS_PER_SECOND = 100;

/** A cap on one waveform's size: a million pairs is 8 MB, reached at 2.8 hours. */
export const MAX_PEAK_BUCKETS = 1_000_000;

/** Seconds between filmstrip frames for a file of `seconds`. */
export function thumbInterval(seconds: number): number {
  if (!(seconds > 0)) return 1;
  return Math.max(0.25, seconds / MAX_THUMBS);
}

/** Pairs per second for a file of `seconds`, so a very long one stays under the cap. */
export function peaksPerSecond(seconds: number): number {
  if (!(seconds > 0)) return PEAKS_PER_SECOND;
  return Math.min(PEAKS_PER_SECOND, MAX_PEAK_BUCKETS / seconds);
}

export type ThumbKind = 'video' | 'image';

/**
 * ffmpeg's arguments for a filmstrip, written as numbered JPEGs into `folder`.
 *
 * A short file is decoded whole and sampled evenly. A long one is read by its
 * keyframes alone (`-skip_frame nokey`): decoding every frame of 45 minutes
 * just to keep 240 of them would take minutes of CPU, where keyframes take
 * seconds. `showinfo` reports each kept frame's real time on stderr.
 */
export function thumbArgs(source: string, folder: string, kind: ThumbKind, seconds: number): string[] {
  const scale = `scale=-2:${THUMB_HEIGHT}:flags=bilinear`;
  const out = ['-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', join(folder, '%05d.jpg')];
  if (kind === 'image') {
    return ['-v', 'info', '-nostats', '-nostdin', '-y', '-i', source, '-frames:v', '1', '-vf', `${scale},showinfo`, ...out];
  }
  const interval = thumbInterval(seconds);
  if (seconds > 0 && seconds <= FULL_DECODE_SECONDS) {
    return [
      '-v', 'info', '-nostats', '-nostdin', '-y', '-threads', '2', '-i', source,
      '-map', '0:v:0', '-an',
      '-vf', `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval.toFixed(3)}),${scale},showinfo`,
      '-fps_mode', 'passthrough', ...out,
    ];
  }
  return [
    '-v', 'info', '-nostats', '-nostdin', '-y', '-threads', '2', '-skip_frame', 'nokey', '-i', source,
    '-map', '0:v:0', '-an',
    '-vf', `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval.toFixed(3)}),${scale},showinfo`,
    '-fps_mode', 'passthrough', ...out,
  ];
}

/** The time of every frame showinfo reported, in order. */
export function parseShowinfoTimes(stderr: string): number[] {
  const times: number[] = [];
  for (const match of stderr.matchAll(/Parsed_showinfo[^\n]*?\bpts_time:\s*(-?[\d.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) times.push(Math.max(0, value));
  }
  return times;
}

/** ffmpeg's arguments for the sound: mono float samples on stdout. */
export function peakArgs(source: string): string[] {
  return [
    '-v', 'error', '-nostdin', '-threads', '2', '-i', source,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE),
    '-f', 'f32le', 'pipe:1',
  ];
}

/**
 * Min/max pairs folded from samples as they arrive: the sound itself is never
 * held, only one pair per bucket.
 */
export class PeakFolder {
  private pairs: Float32Array;
  private buckets = 0;
  private filled = 0;
  private min = 1;
  private max = -1;
  samples = 0;

  constructor(private readonly samplesPerBucket: number, expectedBuckets = 1024) {
    this.pairs = new Float32Array(Math.max(2, expectedBuckets * 2));
  }

  add(chunk: Float32Array): void {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = chunk[index];
      if (sample < this.min) this.min = sample;
      if (sample > this.max) this.max = sample;
      this.filled += 1;
      if (this.filled >= this.samplesPerBucket) this.flush();
    }
    this.samples += chunk.length;
  }

  private flush(): void {
    if (this.buckets * 2 + 2 > this.pairs.length) {
      const grown = new Float32Array(this.pairs.length * 2);
      grown.set(this.pairs);
      this.pairs = grown;
    }
    const empty = this.min > this.max;
    this.pairs[this.buckets * 2] = empty ? 0 : this.min;
    this.pairs[this.buckets * 2 + 1] = empty ? 0 : this.max;
    this.buckets += 1;
    this.filled = 0;
    this.min = 1;
    this.max = -1;
  }

  finish(): Float32Array {
    if (this.filled > 0) this.flush();
    return this.pairs.slice(0, this.buckets * 2);
  }
}

/**
 * A waveform file: "SCFP", the version, the pair count and the duration,
 * then the pairs. Little-endian, as the page reads it back.
 */
export function encodePeaks(pairs: Float32Array, durationSeconds: number): Buffer {
  const header = Buffer.alloc(16);
  header.write('SCFP', 0, 'ascii');
  header.writeUInt32LE(FORMAT_VERSION, 4);
  header.writeUInt32LE(pairs.length / 2, 8);
  header.writeFloatLE(durationSeconds, 12);
  return Buffer.concat([header, Buffer.from(pairs.buffer, pairs.byteOffset, pairs.byteLength)]);
}

/**
 * A filmstrip file: "SCFT", the length of a JSON index, the index (size and
 * each frame's time, offset and length), then the JPEGs back to back.
 */
export function encodeThumbs(frames: { time: number; jpeg: Buffer }[], width: number, height: number): Buffer {
  let offset = 0;
  const index = {
    version: FORMAT_VERSION,
    width,
    height,
    frames: frames.map((frame) => {
      const entry = [Number(frame.time.toFixed(3)), offset, frame.jpeg.length];
      offset += frame.jpeg.length;
      return entry;
    }),
  };
  const json = Buffer.from(JSON.stringify(index), 'utf8');
  const header = Buffer.alloc(8);
  header.write('SCFT', 0, 'ascii');
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json, ...frames.map((frame) => frame.jpeg)]);
}

/** The pixel size of a baseline JPEG, from its SOF marker. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1];
    const length = jpeg.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

export interface ContentJob {
  kind: 'peaks' | 'thumbs';
  path: string;
  seconds: number;
  thumbKind?: ThumbKind;
}

/**
 * The store: one queue, one ffmpeg at a time.
 *
 * `busy` is asked before each job starts; while it says yes (an export is
 * rendering) the queue waits, so a filmstrip never takes a core from a render.
 */
export class ClipContentStore {
  private readonly queue: { job: ContentJob; key: string; resolve: (file: string | null) => void }[] = [];
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private running = false;
  private stopCurrent: (() => void) | null = null;
  /** Why the last job failed, for the log. */
  lastError: string | null = null;

  constructor(
    private readonly folder: string,
    private readonly ffmpeg: string,
    private readonly busy: () => boolean = () => false,
  ) {}

  private async stampFor(path: string): Promise<SourceStamp | null> {
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { path, bytes: info.size, modifiedMs: info.mtimeMs } : null;
  }

  fileFor(key: string, kind: ContentJob['kind']): string {
    return join(this.folder, `${key}-v${FORMAT_VERSION}.${kind === 'peaks' ? 'peaks' : 'thumbs'}`);
  }

  /** The finished file for this job: from the cache, or made now (queued). Null when there is nothing to show. */
  async get(job: ContentJob): Promise<string | null> {
    const stamp = await this.stampFor(job.path);
    if (!stamp) return null;
    const key = proxyKey(stamp);
    const file = this.fileFor(key, job.kind);
    const cached = await stat(file).catch(() => null);
    if (cached?.isFile()) return cached.size > 16 ? file : null;

    const id = `${job.kind}:${key}`;
    const already = this.inFlight.get(id);
    if (already) return already;
    const promise = new Promise<string | null>((resolve) => {
      this.queue.push({ job, key, resolve });
    }).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    void this.pump();
    return promise;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        while (this.busy()) await new Promise((done) => setTimeout(done, 500));
        const next = this.queue.shift();
        if (!next) break;
        const file = this.fileFor(next.key, next.job.kind);
        let result: string | null = null;
        try {
          result = next.job.kind === 'peaks'
            ? await this.makePeaks(next.job, file)
            : await this.makeThumbs(next.job, next.key, file);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
        next.resolve(result);
      }
    } finally {
      this.running = false;
    }
  }

  /** Below the editor's own priority: the timeline can wait a moment for pictures, playback cannot. */
  private lower(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
      setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Not allowed here: it simply runs at normal priority.
    }
  }

  private async makePeaks(job: ContentJob, file: string): Promise<string | null> {
    await mkdir(this.folder, { recursive: true });
    const perSecond = peaksPerSecond(job.seconds);
    const folder = new PeakFolder(Math.max(1, Math.round(PEAK_SAMPLE_RATE / perSecond)), Math.ceil(job.seconds * perSecond) + 8);

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(this.ffmpeg, peakArgs(job.path), { windowsHide: true });
      this.lower(child.pid);
      this.stopCurrent = () => child.kill();
      // Samples arrive in arbitrary byte chunks; a float can straddle two.
      let carry = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => {
        const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const usable = bytes.length - (bytes.length % 4);
        const aligned = Buffer.from(bytes.subarray(0, usable));
        folder.add(new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4));
        carry = Buffer.from(bytes.subarray(usable));
      });
      child.stderr.on('data', () => undefined);
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    this.stopCurrent = null;

    const pairs = folder.finish();
    // No sound at all (a silent video, a still): remembered as an empty file,
    // so it is not measured again every session.
    if (!ok || pairs.length === 0) {
      await writeFile(file, Buffer.alloc(0)).catch(() => undefined);
      return null;
    }
    const temporary = `${file}.part-${process.pid}`;
    await writeFile(temporary, encodePeaks(pairs, folder.samples / PEAK_SAMPLE_RATE));
    await rename(temporary, file);
    return file;
  }

  private async makeThumbs(job: ContentJob, key: string, file: string): Promise<string | null> {
    const work = join(this.folder, `${key}.frames-${process.pid}`);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const stderr = await new Promise<string | null>((resolve) => {
        const child = spawn(this.ffmpeg, thumbArgs(job.path, work, job.thumbKind ?? 'video', job.seconds), { windowsHide: true });
        this.lower(child.pid);
        this.stopCurrent = () => child.kill();
        let log = '';
        child.stderr.on('data', (chunk: Buffer) => {
          log += chunk.toString('utf8');
        });
        child.stdout.on('data', () => undefined);
        child.on('error', () => resolve(null));
        child.on('close', (code) => resolve(code === 0 ? log : null));
      });
      this.stopCurrent = null;
      if (stderr === null) {
        await writeFile(file, Buffer.alloc(0)).catch(() => undefined);
        return null;
      }

      const names = (await readdir(work)).filter((name) => name.endsWith('.jpg')).sort();
      const times = parseShowinfoTimes(stderr);
      const frames: { time: number; jpeg: Buffer }[] = [];
      for (let index = 0; index < names.length; index += 1) {
        const jpeg = await readFile(join(work, names[index]));
        frames.push({ time: times[index] ?? index * thumbInterval(job.seconds), jpeg });
      }
      if (frames.length === 0) {
        await writeFile(file, Buffer.alloc(0)).catch(() => undefined);
        return null;
      }
      const size = jpegSize(frames[0].jpeg) ?? { width: Math.round((THUMB_HEIGHT * 16) / 9), height: THUMB_HEIGHT };
      const temporary = `${file}.part-${process.pid}`;
      await writeFile(temporary, encodeThumbs(frames, size.width, size.height));
      await rename(temporary, file);
      return file;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Stop the job in progress and forget the queue (the app is closing). */
  cancelAll(): void {
    for (const pending of this.queue.splice(0)) pending.resolve(null);
    this.stopCurrent?.();
  }
}
