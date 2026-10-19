import { describe, expect, it } from 'vitest';
import { FrameCheck, middleOf, nearestIndex, ruleIndex, toleranceFor } from '@renderer/engine/frameCheck';
import { frameTimesArgs, parseFrameCrc, parseStartSeconds } from '@main/media/frameTimes';

/** 30 fps, in a millisecond time base as MKV and WebM store it. */
const mkv30 = Array.from({ length: 60 }, (_, index) => Math.round((index * 1000) / 30) / 1000);

describe('ruleIndex', () => {
  it('picks the last frame starting at or before the time', () => {
    expect(ruleIndex(mkv30, 0)).toBe(0);
    expect(ruleIndex(mkv30, 0.05)).toBe(1);
    expect(ruleIndex(mkv30, 0.067)).toBe(2);
    expect(ruleIndex(mkv30, 0.0669)).toBe(1);
    expect(ruleIndex(mkv30, 100)).toBe(59);
  });

  it('gives the first frame for a time before it, and 0 for no frames', () => {
    expect(ruleIndex([0.1, 0.2], 0.05)).toBe(0);
    expect(ruleIndex([], 1)).toBe(0);
  });
});

describe('nearestIndex and toleranceFor', () => {
  it('names a frame only within the tolerance', () => {
    const tolerance = toleranceFor(mkv30);
    expect(tolerance).toBe(0.0005);
    expect(nearestIndex(mkv30, 0.033, tolerance)).toBe(1);
    expect(nearestIndex(mkv30, 0.0333333, tolerance)).toBe(1);
    expect(nearestIndex(mkv30, 0.05, tolerance)).toBe(-1);
  });

  it('stays under a quarter of the shortest gap for dense frames', () => {
    expect(toleranceFor([0, 0.001, 0.002])).toBeCloseTo(0.00025, 9);
  });
});

describe('middleOf', () => {
  it('aims halfway to the next frame, or to the end for the last', () => {
    expect(middleOf([0, 0.04, 0.08], 1, 0.12)).toBeCloseTo(0.06, 9);
    expect(middleOf([0, 0.04, 0.08], 2, 0.12)).toBeCloseTo(0.1, 9);
  });
});

describe('FrameCheck', () => {
  it('tells the right frame from the one before and the keyframe after', () => {
    const check = new FrameCheck(mkv30);
    // Timeline frame 14 at 30 fps: its middle, 14.5 / 30 s, is in frame 14.
    const seconds = 14.5 / 30;
    expect(check.judge(seconds, mkv30[14]).right).toBe(true);
    expect(check.judge(seconds, mkv30[13])).toEqual({ right: false, expected: 14, shown: 13 });
    expect(check.judge(seconds, mkv30[15])).toEqual({ right: false, expected: 14, shown: 15 });
  });

  it('calls a timestamp that names no frame wrong, not right', () => {
    const check = new FrameCheck(mkv30);
    expect(check.judge(0.5, 0.49).right).toBe(false);
    expect(check.judge(0.5, 0.49).shown).toBe(-1);
  });

  it('aims at the middle of the frame the rule picks', () => {
    const check = new FrameCheck(mkv30);
    expect(check.aimFor(14.1 / 30, 2)).toBeCloseTo((mkv30[14] + mkv30[15]) / 2, 9);
  });

  it('settles which clock the element counts in from the first frame that fits only one', () => {
    // Container starts at -0.023 s: the element may count from it, which
    // moves every frame 23 ms later.
    const check = new FrameCheck(mkv30, [0, 0.023]);
    // Until the clock is known, aim at the time asked for: inside the
    // right frame on either clock here.
    expect(check.aimFor(0.5, 2)).toBe(0.5);
    // Frame 15 shown on the shifted clock: fits only that one.
    const verdict = check.judge(15.5 / 30 + 0.023, mkv30[15] + 0.023);
    expect(verdict.right).toBe(true);
    // From now on the raw timestamp of a frame is a timestamp of no frame.
    expect(check.judge(15.5 / 30 + 0.023, mkv30[15]).right).toBe(false);
    expect(check.aimFor(15.5 / 30 + 0.023, 2)).toBeCloseTo((mkv30[15] + mkv30[16]) / 2 + 0.023, 9);
  });
});

describe('frameTimes (ffmpeg framecrc)', () => {
  it('lists the first video stream, copied, with the container timestamps kept', () => {
    const args = frameTimesArgs('C:/clips/a.mkv');
    expect(args).toEqual(expect.arrayContaining(['-copyts', '-map', '0:V:0', '-c', 'copy', '-f', 'framecrc']));
    expect(args[args.indexOf('-i') + 1]).toBe('C:/clips/a.mkv');
  });

  it('reads presentation times in presentation order, B-frames and all', () => {
    const text = [
      '#software: Lavf60.16.100',
      '#tb 0: 1/1000',
      '#media_type 0: video',
      '0,        -67,          0,       33,    99990, 0xa1f2c898',
      '0,        -34,        133,       33,    37488, 0x1e89c08c, F=0x0',
      '0,          0,         67,       33,    16574, 0x99825c76, F=0x0',
      '0,         33,         33,       33,     1934, 0x107bd34b, F=0x0',
      '0,         67,        100,       33,     1900, 0x107bd34c, F=0x0',
      '',
    ].join('\n');
    expect(parseFrameCrc(text)).toEqual([0, 0.033, 0.067, 0.1, 0.133]);
  });

  it('falls back to the decode time for a packet without a presentation time, and drops repeats', () => {
    const text = ['#tb 0: 1/90000', '0, 0, -9223372036854775808, 3000, 10, 0x1', '0, 3000, 3000, 3000, 10, 0x2', '0, 3000, 3000, 3000, 10, 0x3'].join('\n');
    expect(parseFrameCrc(text)).toEqual([0, 3000 / 90000]);
  });

  it('gives nothing without a time base, and reads the start time from the summary', () => {
    expect(parseFrameCrc('0, 1, 1, 1, 1, 0x1')).toEqual([]);
    expect(parseStartSeconds('  Duration: 00:00:02.02, start: -0.023000, bitrate: 2 kb/s')).toBe(-0.023);
    expect(parseStartSeconds('nothing here')).toBe(0);
  });
});
