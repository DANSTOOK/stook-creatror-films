import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMoov, parseMoovAudio, readLayout, type Mp4AudioTrack, type Mp4VideoTrack } from '@renderer/engine/mp4';
import { audioExtractArgs, sourceClockArgs } from '@main/media/audioExtract';
import { peakArgs } from '@main/media/clipContent';

/**
 * Where a track starts: the edit list (ISO/IEC 14496-12 8.6.6) and iTunSMPB.
 *
 * The app's sound used to sit one AAC frame - 23.2 ms at 44.1 kHz - ahead of
 * its picture in every MP4 without an audio edit list, the user's KRATOS vs
 * THOR capture among them, because it dropped a frame of "priming" the file
 * never declared. Empty edits (a track that starts late) were not read at
 * all, so a sound written to start half a second after its picture played at
 * once. These pin the reading down, file by file, against what ffmpeg makes
 * and what ffmpeg reads.
 *
 * Files are ffmpeg's own, and the cases ffmpeg does not write are made by
 * rewriting its moov - which ffmpeg leaves at the END of the file unless told
 * otherwise, so resizing it moves no sample data.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-elst-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): void {
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...args]);
}

/** Two seconds of picture (B-frames on) and 44.1 kHz AAC: the elst ffmpeg writes is the baseline. */
const base = join(dir, 'base.mp4');
run([
  '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
  '-f', 'lavfi', '-i', 'sine=d=2:r=44100',
  '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', base,
]);

/* ---------------------------------------------------------------- boxes */

interface BoxAt {
  type: string;
  at: number;
  size: number;
}

function boxesIn(bytes: Uint8Array, start: number, end: number): BoxAt[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: BoxAt[] = [];
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at);
    if (size < 8) break;
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), at, size });
    at += size;
  }
  return out;
}

const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const length = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(Buffer.from(type, 'latin1'), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The chain of boxes from moov down `types` (a trak picked by handler), or null. */
function chain(bytes: Uint8Array, handler: 'vide' | 'soun', types: string[]): BoxAt[] | null {
  const top = boxesIn(bytes, 0, bytes.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov || moov !== top[top.length - 1]) throw new Error('moov must come last');
  const trak = boxesIn(bytes, moov.at + 8, moov.at + moov.size)
    .filter((b) => b.type === 'trak')
    .find((t) => {
      const mdia = boxesIn(bytes, t.at + 8, t.at + t.size).find((b) => b.type === 'mdia') as BoxAt;
      const hdlr = boxesIn(bytes, mdia.at + 8, mdia.at + mdia.size).find((b) => b.type === 'hdlr') as BoxAt;
      return String.fromCharCode(...bytes.subarray(hdlr.at + 16, hdlr.at + 20)) === handler;
    }) as BoxAt;
  const out = [moov, trak];
  let current = trak;
  for (const type of types) {
    const next = boxesIn(bytes, current.at + 8, current.at + current.size).find((b) => b.type === type);
    if (!next) return null;
    out.push(next);
    current = next;
  }
  return out;
}

/** Replace the last box of `path` (or append `replacement` inside it when `inside`), growing every parent. */
function splice(bytes: Uint8Array, path: BoxAt[], replacement: Uint8Array, inside = false): Uint8Array {
  const target = path[path.length - 1];
  const from = inside ? target.at + target.size : target.at;
  const to = inside ? from : target.at + target.size;
  const out = new Uint8Array(bytes.length - (to - from) + replacement.length);
  out.set(bytes.subarray(0, from));
  out.set(replacement, from);
  out.set(bytes.subarray(to), from + replacement.length);
  const delta = replacement.length - (to - from);
  const view = new DataView(out.buffer);
  for (const parent of inside ? path : path.slice(0, -1)) view.setUint32(parent.at, parent.size + delta);
  return out;
}

interface Edit {
  duration: number;
  mediaTime: number;
}

function elst(edits: Edit[], version: 0 | 1 = 0): Uint8Array {
  const entry = version === 1 ? 20 : 12;
  const body = new Uint8Array(8 + edits.length * entry);
  const view = new DataView(body.buffer);
  view.setUint8(0, version);
  view.setUint32(4, edits.length);
  edits.forEach((edit, i) => {
    const at = 8 + i * entry;
    if (version === 1) {
      view.setBigUint64(at, BigInt(edit.duration));
      view.setBigInt64(at + 8, BigInt(edit.mediaTime));
      view.setInt16(at + 16, 1);
    } else {
      view.setUint32(at, edit.duration);
      view.setInt32(at + 4, edit.mediaTime);
      view.setInt16(at + 8, 1);
    }
  });
  return box('elst', body);
}

/** The file with `handler`'s edit list replaced, or removed when `edits` is null. */
function withEdits(bytes: Uint8Array, handler: 'vide' | 'soun', edits: Edit[] | null, version: 0 | 1 = 0): Uint8Array {
  const edts = chain(bytes, handler, ['edts']);
  if (!edts) throw new Error('no edts to replace');
  return splice(bytes, edts, edits ? box('edts', elst(edits, version)) : new Uint8Array(0));
}

/** An iTunes-style freeform iTunSMPB in moov/udta/meta/ilst. */
function withITunSMPB(bytes: Uint8Array, delay: number): Uint8Array {
  const hex = (value: number, width = 8) => value.toString(16).toUpperCase().padStart(width, '0');
  const value = ` 00000000 ${hex(delay)} 00000000 ${hex(88200, 16)} 00000000 00000000 00000000 00000000`;
  const full = (...parts: Uint8Array[]) => box('xxxx', new Uint8Array(4), ...parts).subarray(8);
  const text = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
  const freeform = box('----',
    box('mean', full(text('com.apple.iTunes'))),
    box('name', full(text('iTunSMPB'))),
    box('data', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), text(value)));
  const hdlr = box('hdlr', full(new Uint8Array(4), text('mdirappl'), new Uint8Array(9)));
  const udta = box('udta', box('meta', full(hdlr, box('ilst', freeform))));
  const top = boxesIn(bytes, 0, bytes.length);
  return splice(bytes, [top[top.length - 1]], udta, true);
}

function save(name: string, bytes: Uint8Array): string {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

async function open(bytes: Uint8Array): Promise<{ audio: Mp4AudioTrack; video: Mp4VideoTrack | null }> {
  const read = async (offset: number, length: number) => bytes.slice(offset, offset + length);
  const layout = await readLayout(read, bytes.byteLength);
  expect(layout).not.toBeNull();
  const audio = parseMoovAudio(layout!.moov, layout!.fragments);
  expect(audio).not.toBeNull();
  return { audio: audio!, video: parseMoov(layout!.moov, layout!.fragments) };
}

/** The pts, in samples, of the first frame ffmpeg's decoder hands out. */
function ffmpegFirstPts(file: string): number {
  const result = spawnSync(ffmpeg, ['-v', 'info', '-nostats', '-copyts', '-i', file, '-map', '0:a:0', '-t', '0.2', '-af', 'ashowinfo', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /ashowinfo[^\n]*? pts:(-?\d+)/.exec(result.stderr as string);
  if (!match) throw new Error('ffmpeg reported no audio frame');
  return Number(match[1]);
}

const RATE = 44100;
const samples = (seconds: number) => Math.round(seconds * RATE);

/* ---------------------------------------------------------------- tests */

describe('the audio edit list', () => {
  it('reads ffmpeg\'s own edit list: the priming frame before zero, the sound at zero', async () => {
    const { audio } = await open(new Uint8Array(readFileSync(base)));
    expect(samples(audio.samples[0].time)).toBe(-1024);
    expect(samples(audio.samples[1].time)).toBe(0);
  });

  /*
   * No edit list: the stored timestamps are the presentation. The priming
   * frame is presented at zero - ffmpeg decodes it there, and so does
   * Chromium's decodeAudioData - and nothing is taken off that the file does
   * not declare.
   */
  it('without an edit list, takes the timestamps as stored', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', null);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(0);
    expect(samples(audio.samples[1].time)).toBe(1024);
    // And ffmpeg agrees: its first decoded frame is at zero.
    expect(ffmpegFirstPts(save('noelst.mp4', bytes))).toBe(0);
  });

  it('honours a media_time other than one frame (Apple encoders write 2112)', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', [{ duration: 2000, mediaTime: 2112 }]);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(-2112);
    expect(samples(audio.samples[3].time)).toBe(3 * 1024 - 2112);
  });

  /*
   * An empty edit (media_time -1) delays the whole track by its duration, in
   * the MOVIE timescale (mvhd: 1000 in ffmpeg's files). ffmpeg rounds it to
   * the track's samples; so does the reader, so both put it on one sample.
   */
  it('delays the track by an empty edit, rounded the way ffmpeg rounds it', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', [
      { duration: 476, mediaTime: -1 },
      { duration: 2000, mediaTime: 0 },
    ]);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(20992); // round(0.476 * 44100)
    expect(ffmpegFirstPts(save('empty.mp4', bytes))).toBe(20992);
  });

  it('adds an empty edit and a skipped priming together', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', [
      { duration: 500, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ]);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(22050 - 1024);
    expect(samples(audio.samples[1].time)).toBe(22050);
  });

  it('reads a version-1 (64-bit) edit list the same', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', [
      { duration: 500, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ], 1);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[1].time)).toBe(22050);
  });

  it('adds up several empty edits in front', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'soun', [
      { duration: 200, mediaTime: -1 },
      { duration: 300, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ]);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[1].time)).toBe(22050);
  });
});

describe('the picture edit list', () => {
  it('starts B-frame video at zero, through its media_time', async () => {
    const { video } = await open(new Uint8Array(readFileSync(base)));
    const first = Math.min(...video!.samples.map((s) => s.time));
    expect(first).toBeCloseTo(0, 6);
  });

  /*
   * A picture that starts late is presented late by Chromium's <video>,
   * which the preview plays through - measured: currentTime 0.2 shows the
   * frame stamped 0.5. Export and the paused preview read pictures through
   * this reader, so it has to put them there too.
   */
  it('delays the picture by an empty edit, as Chromium\'s <video> does', async () => {
    const bytes = withEdits(new Uint8Array(readFileSync(base)), 'vide', [
      { duration: 500, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ]);
    const { video } = await open(bytes);
    const first = Math.min(...video!.samples.map((s) => s.time));
    expect(first).toBeCloseTo(0.5, 6);
  });
});

describe('iTunSMPB', () => {
  it('takes the encoder delay from iTunSMPB when there is no edit list', async () => {
    const bytes = withITunSMPB(withEdits(new Uint8Array(readFileSync(base)), 'soun', null), 1024);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[1].time)).toBe(0);
  });

  it('lets an edit list that already skips the priming win', async () => {
    const bytes = withITunSMPB(new Uint8Array(readFileSync(base)), 2112);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(-1024);
  });

  it('ignores a delay too large to be a codec\'s', async () => {
    const bytes = withITunSMPB(withEdits(new Uint8Array(readFileSync(base)), 'soun', null), 20000);
    const { audio } = await open(bytes);
    expect(samples(audio.samples[0].time)).toBe(0);
  });

  /*
   * The app never reads the source's sound directly: it extracts the audio
   * track first. A plain stream copy keeps the priming samples but loses the
   * tag; the extraction's arguments keep it as a keyed tag, and the reader
   * finds it there.
   */
  it('survives the app\'s own audio extraction', async () => {
    const source = save('itunes.mp4', withITunSMPB(withEdits(new Uint8Array(readFileSync(base)), 'soun', null), 1024));
    const target = join(dir, 'itunes.m4a');
    execFileSync(ffmpeg, audioExtractArgs(source, target, ['-c:a', 'copy']));
    const { audio } = await open(new Uint8Array(readFileSync(target)));
    expect(samples(audio.samples[1].time)).toBe(0);
  });
});

describe('the app\'s ffmpeg reads keep the source clock', () => {
  it('extracts with -copyts for MP4-family sources only', () => {
    expect(sourceClockArgs('C:/a/b.MP4')).toEqual(['-copyts']);
    expect(sourceClockArgs('C:/a/b.mov')).toEqual(['-copyts']);
    expect(sourceClockArgs('C:/a/b.mts')).toEqual([]);
    expect(audioExtractArgs('x.mp4', 'y.m4a', ['-c:a', 'copy'])).toEqual([
      '-v', 'error', '-y', '-copyts', '-i', 'x.mp4', '-vn', '-map', '0:a:0', '-c:a', 'copy', '-movflags', '+use_metadata_tags', 'y.m4a',
    ]);
  });

  /*
   * Both tracks behind empty edits: ffmpeg would move the whole file back by
   * the earlier one, so the extracted sound lost the picture's delay. With
   * the source clock kept, it starts where the source says.
   */
  it('keeps a late sound late when the picture starts late too', async () => {
    const both = withEdits(withEdits(new Uint8Array(readFileSync(base)), 'vide', [
      { duration: 500, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ]), 'soun', [{ duration: 800, mediaTime: -1 }, { duration: 2000, mediaTime: 1024 }]);
    const source = save('both.mp4', both);
    const target = join(dir, 'both.m4a');
    execFileSync(ffmpeg, audioExtractArgs(source, target, ['-c:a', 'copy']));
    const { audio } = await open(new Uint8Array(readFileSync(target)));
    // The sound itself (the second frame) at 0.8 s, give or take the movie
    // timescale's millisecond.
    expect(Math.abs(audio.samples[1].time - 0.8)).toBeLessThan(0.0011);
  });

  /*
   * The waveform is drawn from ffmpeg's decode, so it has to place frames by
   * their timestamps as the streamed reader does: gaps kept, a late start
   * padded with silence.
   */
  it('draws the waveform from timestamp-placed sound', () => {
    const args = peakArgs('C:/clip.mp4');
    expect(args).toContain('-copyts');
    expect(args.join(' ')).toContain('aresample=16000:async=1:min_hard_comp=0:first_pts=0');
    // ffmpeg itself accepts them, on a real file.
    const pcm = execFileSync(ffmpeg, peakArgs(save('late.mp4', withEdits(new Uint8Array(readFileSync(base)), 'soun', [
      { duration: 500, mediaTime: -1 },
      { duration: 2000, mediaTime: 1024 },
    ]))), { maxBuffer: 1 << 26 });
    const values = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    // Silence for the first half second, the tone right after it.
    const firstLoud = values.findIndex((v) => Math.abs(v) > 0.05);
    expect(firstLoud / 16000).toBeGreaterThan(0.49);
    expect(firstLoud / 16000).toBeLessThan(0.51);
  });
});

describe('fragmented files, which carry no edit list', () => {
  /*
   * ffmpeg's fragmented muxer cannot write the priming as an edit list, so it
   * stretches the first audio sample instead: the priming frame at zero, and
   * the first real frame exactly where the first picture is (2/30 s with
   * B-frames). Taking the timestamps as stored keeps them together; dropping
   * an extra frame - what the app used to do - put the sound 23.2 ms early.
   */
  it('puts the first real sound where the first picture is', async () => {
    const file = join(dir, 'frag.mp4');
    run([
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=d=2:r=44100',
      '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', file,
    ]);
    const { audio, video } = await open(new Uint8Array(readFileSync(file)));
    const firstPicture = Math.min(...video!.samples.map((s) => s.time));
    expect(audio.samples[0].time).toBe(0);
    expect(Math.abs(audio.samples[1].time - firstPicture)).toBeLessThan(1 / RATE);
  });
});

