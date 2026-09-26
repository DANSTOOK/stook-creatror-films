import { describe, expect, it } from 'vitest';

import {
  FULL_DECODE_SECONDS,
  MAX_PEAK_BUCKETS,
  MAX_THUMBS,
  PeakFolder,
  encodePeaks,
  encodeThumbs,
  jpegSize,
  parseShowinfoTimes,
  peaksPerSecond,
  thumbArgs,
  thumbInterval,
} from '../src/main/media/clipContent';
import { frameAt, parsePeaksFile, parseThumbsFile } from '../src/renderer/media/clipContent';
import { SHAPE_CONTRAST, TEXT_CONTRAST, over, parseColor, contrastRatio } from '@shared/utils/contrast';
import { NAME_BAND, SOUND_STRIP, TRACK_TYPE_COLORS, WAVE_FILL } from '../src/renderer/components/Timeline/TimelineCanvas';

const asArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

describe('how many pictures a filmstrip keeps', () => {
  it('never more than the cap, however long the file', () => {
    expect(Math.ceil((45 * 60) / thumbInterval(45 * 60))).toBeLessThanOrEqual(MAX_THUMBS);
    expect(Math.ceil(7200 / thumbInterval(7200))).toBeLessThanOrEqual(MAX_THUMBS);
  });

  it('no closer than a quarter of a second, so a short clip is not decoded frame by frame', () => {
    expect(thumbInterval(3)).toBe(0.25);
    expect(thumbInterval(20)).toBe(0.25);
  });

  it('decodes a short file whole and a long one by its keyframes only', () => {
    expect(thumbArgs('in.mp4', 'out', 'video', 20)).not.toContain('-skip_frame');
    expect(thumbArgs('in.mp4', 'out', 'video', FULL_DECODE_SECONDS + 1)).toContain('-skip_frame');
    expect(thumbArgs('in.png', 'out', 'image', 0)).toContain('-frames:v');
  });

  it('reads the time of every kept frame from showinfo', () => {
    const log = [
      '[Parsed_showinfo_2 @ 0000] n:   0 pts:      0 pts_time:0       duration: 1',
      'frame=    0 fps=0.0 [Parsed_showinfo_2 @ 0000] n:   1 pts:2400000 pts_time:2       duration: 1',
      '[Parsed_showinfo_2 @ 0000] n:   2 pts:4800000 pts_time:4.5     duration: 1',
    ].join('\n');
    expect(parseShowinfoTimes(log)).toEqual([0, 2, 4.5]);
  });
});

describe('a waveform measured in the main process', () => {
  it('folds samples into one min/max pair per bucket, across chunk boundaries', () => {
    const folder = new PeakFolder(4, 1);
    folder.add(new Float32Array([0.1, -0.5, 0.2]));
    folder.add(new Float32Array([0.9, 0, 0, -0.25, 0.25, 0.3]));
    expect([...folder.finish()]).toEqual([
      expect.closeTo(-0.5), expect.closeTo(0.9),
      expect.closeTo(-0.25), expect.closeTo(0.25),
      expect.closeTo(0.3), expect.closeTo(0.3),
    ]);
  });

  it('keeps a very long file under the size cap', () => {
    expect(peaksPerSecond(60)).toBe(100);
    expect(peaksPerSecond(5 * 3600) * 5 * 3600).toBeLessThanOrEqual(MAX_PEAK_BUCKETS);
  });

  it('reads back in the page exactly as it was written', () => {
    const pairs = new Float32Array([-0.5, 0.5, -0.25, 0.75]);
    const parsed = parsePeaksFile(asArrayBuffer(encodePeaks(pairs, 0.02)));
    expect(parsed?.bucketCount).toBe(2);
    expect(parsed?.durationSeconds).toBeCloseTo(0.02, 5);
    expect([...(parsed?.peaks ?? [])]).toEqual([-0.5, 0.5, -0.25, 0.75]);
  });

  it('refuses a file that is not one', () => {
    expect(parsePeaksFile(new ArrayBuffer(0))).toBeNull();
    expect(parsePeaksFile(new TextEncoder().encode('not a waveform file!').buffer as ArrayBuffer)).toBeNull();
  });
});

describe('a filmstrip made in the main process', () => {
  // The smallest JPEG header that says its size: SOI, then a SOF0 of 128x72.
  const fakeJpeg = (tag: number): Buffer =>
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 72, 0x00, 128, 0x03, tag, 0xff, 0xd9]);

  it('reads a JPEG\'s size from its header', () => {
    expect(jpegSize(fakeJpeg(1))).toEqual({ width: 128, height: 72 });
  });

  it('packs the frames with their times, and the page finds each one', () => {
    const frames = [0, 2, 4].map((time, index) => ({ time, jpeg: fakeJpeg(index) }));
    const parsed = parseThumbsFile(asArrayBuffer(encodeThumbs(frames, 128, 72)));
    expect(parsed?.times).toEqual([0, 2, 4]);
    expect(parsed?.width).toBe(128);
    const [offset, length] = parsed?.spans[2] ?? [0, 0];
    expect(Buffer.from(parsed?.data ?? new ArrayBuffer(0), offset, length).equals(fakeJpeg(2))).toBe(true);
  });

  it('shows, for a moment of the source, the last picture at or before it', () => {
    const times = [0, 2, 4, 6];
    expect(frameAt(times, 0)).toBe(0);
    expect(frameAt(times, 3.9)).toBe(1);
    expect(frameAt(times, 4)).toBe(2);
    expect(frameAt(times, 99)).toBe(3);
    expect(frameAt(times, -1)).toBe(0);
    expect(frameAt([], 1)).toBe(-1);
  });
});

describe('what the timeline draws them in can be read', () => {
  const rgb = (value: string) => {
    const parsed = parseColor(value);
    if (!parsed) throw new Error(value);
    return parsed;
  };
  const flat = (value: string, under: [number, number, number]) => {
    const { rgb: top, alpha } = rgb(value);
    return over(top, alpha, under);
  };

  it('a waveform stands out 3:1 from the clip it is drawn on', () => {
    const audio = rgb(TRACK_TYPE_COLORS.audio).rgb;
    expect(contrastRatio(rgb(WAVE_FILL.audio).rgb, audio)).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
    const strip = flat(SOUND_STRIP, rgb(TRACK_TYPE_COLORS.video).rgb);
    expect(contrastRatio(rgb(WAVE_FILL.video).rgb, strip)).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
  });

  it('a clip name over a white picture still reads at 4.5:1', () => {
    const chip = flat(NAME_BAND, [255, 255, 255]);
    expect(contrastRatio(rgb('#e2e8f0').rgb, chip)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });
});
