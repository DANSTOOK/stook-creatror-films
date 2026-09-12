import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMoov, parseMoovAudio, readLayout, type Mp4Sample } from '@renderer/engine/mp4';

/**
 * Fragmented MP4 - the file that exported at 23 fps.
 *
 * The user's 19-minute KRATOS vs THOR recording is a fragmented MP4: a moov of
 * 1,329 bytes with empty sample tables, then 344 movie fragments (moof + mdat),
 * each holding a video and an audio track fragment. Every sample the file has
 * is described in those fragments, and the reader only ever looked in moov.
 * It found no samples, so export fell back to seeking every frame and the
 * audio fell back to decoding the whole file.
 *
 * The same content is encoded plain and fragmented three ways, and the
 * fragmented reading has to match the plain one sample for sample - down to
 * the bytes each sample points at.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-fmp4-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Deterministic encodes: one thread, fixed GOP, B-frames on. */
function encode(name: string, container: string[]): Uint8Array {
  const file = join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-shortest', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-profile:v', 'high', '-bf', '2', '-g', '30', '-threads', '1',
    '-c:a', 'aac', '-b:a', '128k',
    ...container, file,
  ]);
  return new Uint8Array(readFileSync(file));
}

const readerFor = (bytes: Uint8Array) => async (offset: number, length: number) =>
  bytes.slice(offset, offset + length);

async function open(bytes: Uint8Array) {
  const layout = await readLayout(readerFor(bytes), bytes.byteLength);
  expect(layout).not.toBeNull();
  return {
    fragments: layout!.fragments.length,
    video: parseMoov(layout!.moov, layout!.fragments),
    audio: parseMoovAudio(layout!.moov, layout!.fragments),
  };
}

const payload = (bytes: Uint8Array, sample: Mp4Sample) => bytes.slice(sample.offset, sample.offset + sample.size);

const plain = encode('plain.mp4', ['-movflags', '+faststart']);
const variants: Record<string, Uint8Array> = {
  'offsets from the moof (default-base-is-moof)': encode('moof.mp4', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']),
  'explicit base data offsets': encode('base.mp4', ['-movflags', 'frag_keyframe+empty_moov']),
  'fragments shorter than a GOP': encode('small.mp4', ['-movflags', 'empty_moov+default_base_moof', '-frag_duration', '300000']),
};

describe('the fixtures are what they claim to be', () => {
  it('the plain file has no fragments and the others do', async () => {
    expect((await open(plain)).fragments).toBe(0);
    for (const bytes of Object.values(variants)) {
      expect((await open(bytes)).fragments).toBeGreaterThan(1);
    }
  });

  it('a fragmented moov on its own describes no samples - the old reading', async () => {
    const layout = await readLayout(readerFor(variants['explicit base data offsets']), variants['explicit base data offsets'].byteLength);
    expect(parseMoov(layout!.moov)?.samples.length ?? 0).toBe(0);
  });
});

for (const [name, bytes] of Object.entries(variants)) {
  describe(`fragmented MP4: ${name}`, () => {
    it('reads every video sample exactly as the plain file has it', async () => {
      const reference = (await open(plain)).video!;
      const video = (await open(bytes)).video;
      expect(video).not.toBeNull();
      expect(video!.codec).toBe(reference.codec);
      expect([video!.width, video!.height]).toEqual([320, 240]);
      expect(video!.samples).toHaveLength(reference.samples.length);

      video!.samples.forEach((sample, i) => {
        const expected = reference.samples[i];
        expect(sample.size).toBe(expected.size);
        expect(sample.isSync).toBe(expected.isSync);
        expect(sample.duration).toBeCloseTo(expected.duration, 5);
        expect(payload(bytes, sample)).toEqual(payload(plain, expected));
      });
    });

    it('puts presentation times on the frame grid, where ffmpeg shows them', async () => {
      const video = (await open(bytes)).video!;
      const times = video.samples.map((sample) => sample.time).sort((a, b) => a - b);
      // No edit list in these files, so the B-frame delay is not taken back:
      // ffmpeg's own decode (showinfo) presents the first frame at 2/30 s,
      // where the plain file, which has an edit list, starts at zero.
      expect(times[0]).toBeCloseTo(2 / 30, 3);
      times.forEach((time, i) => expect(time - times[0]).toBeCloseTo(i / 30, 3));
    });

    it('reads every audio sample exactly as the plain file has it', async () => {
      const reference = (await open(plain)).audio!;
      const audio = (await open(bytes)).audio;
      expect(audio).not.toBeNull();
      expect([audio!.sampleRate, audio!.channels]).toEqual([reference.sampleRate, reference.channels]);
      expect(audio!.samples).toHaveLength(reference.samples.length);

      audio!.samples.forEach((sample, i) => {
        const expected = reference.samples[i];
        expect(sample.size).toBe(expected.size);
        expect(payload(bytes, sample)).toEqual(payload(plain, expected));
      });
    });
  });
}
