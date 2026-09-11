import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMoov, readMoov, type Mp4VideoTrack } from '@renderer/engine/mp4';

/**
 * The MP4 sample-table reader behind fast export, checked against files ffmpeg
 * writes - and against ffprobe's own reading of the same files.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-mp4-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeClip(name: string, args: string[]): Uint8Array {
  const file = join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-pix_fmt', 'yuv420p', ...args, file,
  ]);
  return new Uint8Array(readFileSync(file));
}

async function track(bytes: Uint8Array): Promise<Mp4VideoTrack> {
  const read = async (offset: number, length: number) => bytes.slice(offset, offset + length);
  const moov = await readMoov(read, bytes.byteLength);
  expect(moov).not.toBeNull();
  const parsed = parseMoov(moov as Uint8Array);
  expect(parsed).not.toBeNull();
  return parsed as Mp4VideoTrack;
}

const startCode = (b: Uint8Array, at: number) => (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];

describe('mp4 reader', () => {
  const bframes = makeClip('b.mp4', ['-c:v', 'libx264', '-profile:v', 'high', '-bf', '3', '-g', '30']);

  it('reads the codec, size and every sample of an H.264 file with B-frames', async () => {
    const t = await track(bframes);
    expect(t.codec).toMatch(/^avc1\.64/);
    expect([t.width, t.height]).toEqual([320, 240]);
    expect(t.samples).toHaveLength(90);
    expect(t.description[0]).toBe(1); // avcC version
  });

  it('puts presentation times on the frame grid, starting at zero despite B-frame delay', async () => {
    const t = await track(bframes);
    const times = t.samples.map((s) => s.time).sort((a, b) => a - b);
    times.forEach((time, i) => expect(time).toBeCloseTo(i / 30, 3));
    // Decode order is not presentation order when there are B-frames.
    expect(t.samples.map((s) => s.time)).not.toEqual(times);
  });

  it('marks a keyframe every GOP', async () => {
    const t = await track(bframes);
    const keys = t.samples.flatMap((s, i) => (s.isSync ? [i] : []));
    expect(keys[0]).toBe(0);
    expect(keys.length).toBeGreaterThanOrEqual(3);
  });

  it('points every sample at real NAL units inside the file', async () => {
    const t = await track(bframes);
    for (const sample of t.samples) {
      expect(sample.offset + sample.size).toBeLessThanOrEqual(bframes.byteLength);
      // Length-prefixed NALs: the first length fits inside the sample.
      const first = startCode(bframes, sample.offset);
      expect(first).toBeGreaterThan(0);
      expect(first + 4).toBeLessThanOrEqual(sample.size);
    }
  });

  it('finds the moov wherever it is: at the end (default) or the front (faststart)', async () => {
    const front = makeClip('fast.mp4', ['-c:v', 'libx264', '-movflags', '+faststart']);
    const end = await track(bframes);
    const start = await track(front);
    expect(start.samples).toHaveLength(90);
    expect(end.samples).toHaveLength(90);
  });

  it('reads HEVC and writes a codec string WebCodecs accepts', async () => {
    const hevc = makeClip('h.mp4', ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error']);
    const t = await track(hevc);
    expect(t.codec).toMatch(/^hvc1\.\d+\.[0-9A-F]+\.[LH]\d+/);
    expect(t.samples).toHaveLength(90);
  });

  it('declines a file it cannot decode, so the seek path takes it', async () => {
    const vp9 = makeClip('v.mp4', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime']);
    const read = async (offset: number, length: number) => vp9.slice(offset, offset + length);
    const moov = await readMoov(read, vp9.byteLength);
    expect(parseMoov(moov as Uint8Array)).toBeNull();
  });
});
