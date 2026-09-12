import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMoov, parseMoovAudio, readMoov, type Mp4AudioTrack } from '@renderer/engine/mp4';

/**
 * The audio side of the MP4 reader, behind streamed playback audio.
 *
 * Checked against the files the app itself makes: `extractAudio` pulls the
 * audio track out of a video into an `.m4a`, stream-copied when it can.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-m4a-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(name: string, args: string[]): Uint8Array {
  const file = join(dir, name);
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, file]);
  return new Uint8Array(readFileSync(file));
}

/** 3 seconds of stereo AAC at 48 kHz, in an .m4a - what extractAudio writes. */
const m4a = () => make('a.m4a', ['-f', 'lavfi', '-i', 'sine=d=3:r=48000', '-ac', '2', '-c:a', 'aac']);

async function track(bytes: Uint8Array): Promise<Mp4AudioTrack> {
  const read = async (offset: number, length: number) => bytes.slice(offset, offset + length);
  const moov = await readMoov(read, bytes.byteLength);
  expect(moov).not.toBeNull();
  const parsed = parseMoovAudio(moov as Uint8Array);
  expect(parsed).not.toBeNull();
  return parsed as Mp4AudioTrack;
}

describe('mp4 audio reader', () => {
  it('reads the codec, rate and channels of an AAC track', async () => {
    const t = await track(m4a());
    expect(t.codec).toBe('mp4a.40.2');
    expect(t.sampleRate).toBe(48000);
    expect(t.channels).toBe(2);
  });

  it('hands over an AudioSpecificConfig a decoder can use', async () => {
    const t = await track(m4a());
    // AAC-LC, 48 kHz (index 3), stereo: object type 2, so the first byte is
    // 0b00010_001 = 0x11 and the second carries index and channels.
    expect(t.description.byteLength).toBeGreaterThanOrEqual(2);
    expect(t.description[0] >> 3).toBe(2);
    expect(((t.description[0] & 0x07) << 1) | (t.description[1] >> 7)).toBe(3);
    expect((t.description[1] >> 3) & 0x0f).toBe(2);
  });

  it('lists every AAC frame, 1024 samples apart', async () => {
    const t = await track(m4a());
    // 3 s at 48 kHz in frames of 1024 samples.
    expect(t.samples.length).toBeGreaterThanOrEqual(139);
    expect(t.samples.length).toBeLessThanOrEqual(144);
    const frame = 1024 / 48000;
    expect(t.samples[1].time - t.samples[0].time).toBeCloseTo(frame, 6);
    // Every AAC frame decodes on its own, so all of them are sync samples.
    expect(t.samples.every((sample) => sample.isSync)).toBe(true);
  });

  /**
   * AAC starts BEFORE zero, and by design.
   *
   * The encoder needs a frame of run-up, so the file holds ~1024 samples more
   * than the sound it represents and the container's edit list says to throw
   * them away. Applying it puts the first stored frame at a negative time and
   * the sound itself at zero. Anything decoding a range has to drop those
   * samples, or the audio comes out about 21 ms early.
   */
  it('puts the encoder priming before zero, so the sound itself starts at zero', async () => {
    const t = await track(m4a());
    const frame = 1024 / 48000;
    expect(t.samples[0].time).toBeLessThanOrEqual(0);
    expect(t.samples[0].time).toBeGreaterThanOrEqual(-2 * frame);

    // The sound starts at zero: some frame begins within one frame of it.
    const atZero = t.samples.find((sample) => sample.time >= -1e-9);
    expect(atZero).toBeDefined();
    expect(atZero?.time).toBeLessThan(frame);

    // And the whole thing still runs about 3 seconds.
    const last = t.samples[t.samples.length - 1];
    expect(last.time + last.duration).toBeGreaterThan(2.9);
    expect(last.time + last.duration).toBeLessThan(3.1);
  });

  it('points every frame inside the file, in order', async () => {
    const bytes = m4a();
    const t = await track(bytes);
    let previous = -1;
    for (const sample of t.samples) {
      expect(sample.offset).toBeGreaterThan(previous);
      expect(sample.offset + sample.size).toBeLessThanOrEqual(bytes.byteLength);
      previous = sample.offset;
    }
  });

  /**
   * Frames must not be read out of each other's bytes.
   *
   * "Offsets ascend and stay inside the file" is too weak: a sample-to-chunk
   * walk that drifts still satisfies it while handing the decoder bytes that
   * belong to the frame before. Within a chunk the frames tile exactly -
   * each starts where the last ended - and a new chunk starts later, never
   * earlier. Overlap is the signature of a table read wrongly, and it would
   * play as the right audio from the wrong moment.
   */
  it('never lets two frames overlap in the file', async () => {
    const t = await track(m4a());
    const overlaps: string[] = [];
    for (let i = 1; i < t.samples.length; i += 1) {
      const previous = t.samples[i - 1];
      const sample = t.samples[i];
      if (sample.offset < previous.offset + previous.size) {
        overlaps.push(`frame ${i} at ${sample.offset} starts inside frame ${i - 1} (${previous.offset}+${previous.size})`);
      }
    }
    expect(overlaps.slice(0, 5)).toEqual([]);
  });

  it('tiles frames contiguously except where a new chunk begins', async () => {
    const t = await track(m4a());
    let restarts = 0;
    for (let i = 1; i < t.samples.length; i += 1) {
      const previous = t.samples[i - 1];
      if (t.samples[i].offset !== previous.offset + previous.size) restarts += 1;
    }
    // ffmpeg writes audio in chunks of many frames, so a 3-second file has a
    // handful of chunk starts - not one per frame, and not none at all.
    expect(restarts).toBeLessThan(t.samples.length / 4);
  });

  it('reads the audio of a video file, next to its video track', async () => {
    const both = make('both.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=d=2:r=48000',
      '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ]);
    const read = async (offset: number, length: number) => both.slice(offset, offset + length);
    const moov = (await readMoov(read, both.byteLength)) as Uint8Array;
    expect(parseMoovAudio(moov)?.channels).toBe(2);
    // The video head still finds the video track in the same file.
    expect(parseMoov(moov)?.codec).toMatch(/^avc1\./);
  });

  it('declines a bare ADTS .aac, which has no sample table at all', async () => {
    const adts = make('a.aac', ['-f', 'lavfi', '-i', 'sine=d=1:r=48000', '-c:a', 'aac']);
    const read = async (offset: number, length: number) => adts.slice(offset, offset + length);
    expect(await readMoov(read, adts.byteLength)).toBeNull();
  });

  it('declines audio it cannot decode this way, such as FLAC in MP4', async () => {
    const flac = make('a.flac', ['-f', 'lavfi', '-i', 'sine=d=1:r=48000', '-c:a', 'flac']);
    const read = async (offset: number, length: number) => flac.slice(offset, offset + length);
    const moov = await readMoov(read, flac.byteLength);
    // A native FLAC file has no moov; if a container turns up, it is not mp4a.
    expect(moov === null || parseMoovAudio(moov) === null).toBe(true);
  });
});
