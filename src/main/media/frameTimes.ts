import { spawn } from 'node:child_process';

/**
 * The presentation time of every frame of a video file, for checking which
 * frame a seeked <video> really shows.
 *
 * Files WebCodecs cannot read - MKV, WebM and the like - are exported by
 * seeking a <video> to each frame, and Chromium's element sometimes settles
 * on the wrong one while claiming the right time. The renderer can read the
 * timestamp of the frame the element shows; what it cannot know without a
 * demuxer is which timestamp it should have been. ffmpeg can: copying the
 * video stream into `framecrc` lists every packet's timestamp without
 * decoding a single picture, so even a long file takes seconds.
 *
 * `-copyts` keeps the container's own timestamps, which is what Chromium's
 * element reports (it uses FFmpeg's demuxers too): measured equal on MP4,
 * MKV and WebM, B-frames and negative start times included.
 */

/** ffmpeg's arguments: the first video stream (not a cover picture), copied, listed. */
export function frameTimesArgs(path: string): string[] {
  return ['-hide_banner', '-nostdin', '-nostats', '-copyts', '-i', path, '-map', '0:V:0', '-c', 'copy', '-f', 'framecrc', '-'];
}

/** FFmpeg's AV_NOPTS_VALUE, printed for a packet with no timestamp. */
const NO_TIMESTAMP = -9223372036854775808n;

/**
 * Presentation times, in seconds and ascending, from `framecrc` output.
 *
 * Each packet is a line `stream, dts, pts, duration, size, crc[, flags]`
 * under a `#tb 0: num/den` header. A packet without a presentation time
 * (some AVI) falls back to its decode time.
 */
export function parseFrameCrc(text: string): number[] {
  const base = /^#tb 0: (\d+)\/(\d+)/m.exec(text);
  if (!base) return [];
  const num = Number(base[1]);
  const den = Number(base[2]);
  const times: number[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(',');
    if (fields.length < 5 || fields[0].trim() !== '0') continue;
    const pick = (field: string | undefined): bigint | null => {
      const value = field?.trim();
      if (!value || !/^-?\d+$/.test(value)) return null;
      const parsed = BigInt(value);
      return parsed === NO_TIMESTAMP ? null : parsed;
    };
    const stamp = pick(fields[2]) ?? pick(fields[1]);
    if (stamp === null) continue;
    times.push((Number(stamp) * num) / den);
  }
  times.sort((a, b) => a - b);
  // A repeated timestamp is one picture as far as the element is concerned.
  return times.filter((time, index) => index === 0 || time !== times[index - 1]);
}

/** The container's start time from ffmpeg's summary, 0 when it gives none. */
export function parseStartSeconds(stderr: string): number {
  const start = /\bstart:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
  return start ? Number(start[1]) : 0;
}

export interface VideoFrameTimes {
  /** Presentation time of every frame, in seconds, ascending. */
  times: number[];
  /** The container's start time, which a player may count from instead. */
  startSeconds: number;
}

/** Run ffmpeg over `path`; null when it cannot list any frame. */
export function readFrameTimes(ffmpeg: string, path: string): Promise<VideoFrameTimes | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, frameTimesArgs(path), { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // Only the summary at the top is wanted; a broken file can print a lot.
      if (err.length < 64 * 1024) err += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const times = code === 0 ? parseFrameCrc(Buffer.concat(out).toString('utf8')) : [];
      resolve(times.length > 0 ? { times, startSeconds: parseStartSeconds(err) } : null);
    });
  });
}
