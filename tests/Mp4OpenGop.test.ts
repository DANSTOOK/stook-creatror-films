import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { isIdrAccessUnit, parseMoov, readLayout, restartIndexBefore, type Mp4Sample } from '@renderer/engine/mp4';

/**
 * Open-GOP recordings mark plain I-frames as sync samples.
 *
 * The user's KRATOS vs THOR footage has 344 sync samples and only 212 IDR
 * frames. A decoder restarted on one of the other 132 - dragging the playhead
 * back to frame 539, whose sync sample is a plain I-frame - threw "A key frame
 * is required after configure()", and scrubbing fell back to seeking. The
 * reader must restart on IDR frames only.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-opengop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function encode(name: string, x264: string): Uint8Array {
  const file = join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=10',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '1',
    // Open GOPs: the regular keyframes are I-frames with a recovery point, as
    // a streaming recorder writes them. A forced keyframe every 3 s is an IDR.
    '-x264-params', x264,
    // Without -forced-idr, x264 makes forced keyframes open-GOP I-frames too,
    // and the file would have a single IDR - frame 0.
    '-force_key_frames', 'expr:gte(t,n_forced*3)', '-forced-idr', '1',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    file,
  ]);
  return new Uint8Array(readFileSync(file));
}

async function open(bytes: Uint8Array) {
  const read = async (offset: number, length: number) => bytes.slice(offset, offset + length);
  const layout = await readLayout(read, bytes.byteLength);
  const track = parseMoov(layout!.moov, layout!.fragments)!;
  const lengthSize = (track.description[4] & 0x03) + 1;
  const sampleBytes = async (sample: Mp4Sample) => bytes.slice(sample.offset, sample.offset + sample.size);
  return { track, lengthSize, sampleBytes };
}

// A keyframe every second with open GOPs; forced IDRs every 3 s (see encode).
const openGop = encode('open.mp4', 'open-gop=1:keyint=30:min-keyint=30:scenecut=0');

describe('isIdrAccessUnit', () => {
  const nal = (type: number, size = 6) => [0, 0, 0, size, type, ...new Array(size - 1).fill(0xaa)];

  it('finds an IDR slice after an SEI', () => {
    expect(isIdrAccessUnit(new Uint8Array([...nal(6), ...nal(5)]), 4)).toBe(true);
  });

  it('says no for a plain I-frame with a recovery point', () => {
    expect(isIdrAccessUnit(new Uint8Array([...nal(6), ...nal(1)]), 4)).toBe(false);
  });

  it('gives up on a malformed length instead of reading past the end', () => {
    expect(isIdrAccessUnit(new Uint8Array([0, 0, 0, 99, 5]), 4)).toBe(false);
  });
});

describe('an open-GOP file', () => {
  it('really does mark non-IDR frames as sync - the fixture proves the problem', async () => {
    const { track, lengthSize, sampleBytes } = await open(openGop);
    const sync = track.samples.filter((sample) => sample.isSync);
    const idr = [];
    for (const sample of sync) if (isIdrAccessUnit(await sampleBytes(sample), lengthSize)) idr.push(sample);
    expect(sync.length).toBeGreaterThan(idr.length);
    expect(idr.length).toBeGreaterThan(1);
  });

  it('restarts a decoder only on IDR frames, wherever the playhead lands', async () => {
    const { track, lengthSize, sampleBytes } = await open(openGop);
    for (let index = 0; index < track.samples.length; index += 7) {
      const start = await restartIndexBefore(track, index, sampleBytes);
      expect(start).toBeLessThanOrEqual(index);
      expect(isIdrAccessUnit(await sampleBytes(track.samples[start]), lengthSize)).toBe(true);
    }
  });

  it('never starts further back than the nearest IDR', async () => {
    const { track, lengthSize, sampleBytes } = await open(openGop);
    const last = track.samples.length - 1;
    const start = await restartIndexBefore(track, last, sampleBytes);
    for (let index = start + 1; index <= last; index += 1) {
      const sample = track.samples[index];
      if (sample.isSync) expect(isIdrAccessUnit(await sampleBytes(sample), lengthSize)).toBe(false);
    }
  });
});
