import { describe, expect, it } from 'vitest';
import { clearRange, editLength } from '../src/renderer/components/Timeline/threePoint';
import {
  EMPTY_RANGE,
  effectiveRange,
  rangeLength,
  withInPoint,
  withOutPoint,
} from '../src/renderer/store/markRange';
import { shuttleLabel, shuttleRate } from '../src/renderer/hooks/shuttle';
import { createClip } from '../src/renderer/store/types';
import type { Clip } from '../src/shared/types';

const clip = (id: string, start: number, length: number, offset = 0): Clip => ({
  ...createClip({ trackId: 'v1', name: id, sourceUri: `blob:${id}`, startFrame: start, durationFrames: length }),
  id,
  sourceOffsetFrames: offset,
});

const byId = (...clips: Clip[]): Record<string, Clip> => Object.fromEntries(clips.map((c) => [c.id, c]));

describe('in and out points', () => {
  it('marks a range, with the out point past the last frame it keeps', () => {
    const marked = withOutPoint(withInPoint(EMPTY_RANGE, 100), 199);
    expect(marked).toEqual({ inFrame: 100, outFrame: 200 });
    expect(rangeLength(marked)).toBe(100);
  });

  it('drops the other mark rather than keeping a backwards range', () => {
    const backwards = withInPoint({ inFrame: 10, outFrame: 50 }, 80);
    expect(backwards).toEqual({ inFrame: 80, outFrame: null });

    const other = withOutPoint({ inFrame: 60, outFrame: null }, 20);
    expect(other).toEqual({ inFrame: null, outFrame: 21 });
  });

  it('reads one mark as "from here" or "up to here", and none as everything', () => {
    expect(effectiveRange({ inFrame: 120, outFrame: null }, 900)).toEqual({ start: 120, end: 900 });
    expect(effectiveRange({ inFrame: null, outFrame: 300 }, 900)).toEqual({ start: 0, end: 300 });
    expect(effectiveRange(EMPTY_RANGE, 900)).toEqual({ start: 0, end: 900 });
    expect(rangeLength(EMPTY_RANGE)).toBeNull();
  });
});

describe('the shuttle', () => {
  it('goes 1x, 2x, 4x, 8x and no further', () => {
    let rate = 0;
    for (const expected of [1, 2, 4, 8, 8]) {
      rate = shuttleRate(rate, 1);
      expect(rate).toBe(expected);
    }
  });

  it('runs backwards the same way', () => {
    let rate = 0;
    for (const expected of [-1, -2, -4, -8, -8]) {
      rate = shuttleRate(rate, -1);
      expect(rate).toBe(expected);
    }
  });

  it('slows down before turning around', () => {
    // L L L then J: 8x, 4x, 2x, 1x, then backwards.
    let rate = 8;
    for (const expected of [4, 2, 1, -1]) {
      rate = shuttleRate(rate, -1);
      expect(rate).toBe(expected);
    }
  });

  it('shows the speed only when it is not ordinary play', () => {
    expect(shuttleLabel(1)).toBe('');
    expect(shuttleLabel(0)).toBe('');
    expect(shuttleLabel(4)).toBe('4x');
    expect(shuttleLabel(-2)).toBe('-2x');
  });
});

describe('emptying a stretch for an overwrite', () => {
  it('takes out a clip that sits entirely inside it', () => {
    const result = clearRange(byId(clip('a', 100, 50)), 'v1', 90, 200);
    expect(result.removed).toEqual(['a']);
    expect(Object.keys(result.clips)).toHaveLength(0);
  });

  it('clips the tail of one that starts before it', () => {
    const result = clearRange(byId(clip('a', 0, 200)), 'v1', 120, 300);
    expect(result.clips.a.startFrame).toBe(0);
    expect(result.clips.a.durationFrames).toBe(120);
  });

  it('clips the head of one that runs past it, keeping its own footage', () => {
    const result = clearRange(byId(clip('a', 100, 200, 500)), 'v1', 50, 160);
    expect(result.clips.a.startFrame).toBe(160);
    expect(result.clips.a.durationFrames).toBe(140);
    // 60 frames were trimmed off the head, so the source starts 60 later.
    expect(result.clips.a.sourceOffsetFrames).toBe(560);
  });

  it('splits one that straddles it, and the tail keeps the right footage', () => {
    const result = clearRange(byId(clip('a', 0, 300, 1000)), 'v1', 100, 200);
    expect(result.added).toHaveLength(1);
    const head = result.clips.a;
    const tail = result.clips[result.added[0]];
    expect([head.startFrame, head.durationFrames]).toEqual([0, 100]);
    expect([tail.startFrame, tail.durationFrames]).toEqual([200, 100]);
    expect(tail.sourceOffsetFrames).toBe(1200);
  });

  it('leaves other tracks and clips outside the stretch alone', () => {
    const elsewhere = { ...clip('b', 100, 50), trackId: 'v2' };
    const after = clip('c', 400, 50);
    const result = clearRange(byId(clip('a', 100, 50), elsewhere, after), 'v1', 90, 200);
    expect(result.clips.b).toEqual(elsewhere);
    expect(result.clips.c).toEqual(after);
  });

  it('does nothing for an empty stretch', () => {
    const only = byId(clip('a', 0, 100));
    expect(clearRange(only, 'v1', 50, 50).clips).toEqual(only);
  });
});

describe('how long a three-point edit lasts', () => {
  it('is the marked range when there is one, capped by the source', () => {
    expect(editLength(500, 120)).toBe(120);
    expect(editLength(90, 120)).toBe(90);
  });

  it('is the whole source when nothing is marked', () => {
    expect(editLength(500, null)).toBe(500);
  });

  it('is never nothing', () => {
    expect(editLength(500, 0)).toBe(1);
  });
});
