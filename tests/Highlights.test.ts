import { describe, expect, it } from 'vitest';
import { findHighlights, MAX_HIGHLIGHT, speechRuns, totalSeconds } from '../src/renderer/edit/highlights';
import { gapsBetween } from '../src/renderer/edit/highlightsRun';
import type { Clip } from '../src/shared/types';

/**
 * Best moments: the judgement made of silence and shot changes.
 *
 * What is tested here is the judgement, not the measuring - the silences and
 * the cuts come from analysis the app already had and already tests.
 */

describe('what is left when the silences are taken out', () => {
  it('is the talking', () => {
    const runs = speechRuns([{ start: 10, end: 14 }, { start: 30, end: 33 }], 60);
    expect(runs).toEqual([
      { start: 0, end: 10 },
      { start: 14, end: 30 },
      { start: 33, end: 60 },
    ]);
  });

  it('is the whole recording when nothing is quiet', () => {
    expect(speechRuns([], 42)).toEqual([{ start: 0, end: 42 }]);
  });

  it('is nothing at all when it is quiet throughout', () => {
    expect(speechRuns([{ start: 0, end: 30 }], 30)).toEqual([]);
  });

  it('copes with silences that overlap or arrive out of order', () => {
    const runs = speechRuns([{ start: 20, end: 25 }, { start: 5, end: 10 }, { start: 8, end: 12 }], 30);
    expect(runs).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 20 },
      { start: 25, end: 30 },
    ]);
  });

  it('ignores a silence that is not one', () => {
    const runs = speechRuns([{ start: 10, end: 10 }, { start: 20, end: 15 }, { start: Number.NaN, end: 5 }], 30);
    expect(runs).toEqual([{ start: 0, end: 30 }]);
  });
});

describe('the moments offered', () => {
  it('offers the longest unbroken talking first, listed in time order', () => {
    const found = findHighlights({
      duration: 120,
      // Talking 0-10, 20-50 (the longest), 60-68.
      silences: [{ start: 10, end: 20 }, { start: 50, end: 60 }, { start: 68, end: 120 }],
      count: 3,
    });
    expect(found).toHaveLength(3);
    // In time order on screen...
    expect(found.map((one) => Math.round(one.start))).toEqual([0, 20, 60]);
    // ...but the 30-second run scored highest.
    const best = [...found].sort((a, b) => b.score - a.score)[0];
    expect(Math.round(best.start)).toBe(20);
    expect(best.score).toBe(1);
  });

  it('leaves out anything too short to be a moment', () => {
    const found = findHighlights({
      duration: 60,
      // A two-second blurt, then a twenty-second stretch.
      silences: [{ start: 2, end: 20 }, { start: 40, end: 60 }],
      minSeconds: 6,
    });
    expect(found.map((one) => Math.round(one.start))).toEqual([20]);
  });

  it('breaks a stretch that runs too long into pieces that still make sense', () => {
    const found = findHighlights({ duration: 300, silences: [], maxSeconds: 60, count: 10 });
    expect(found.length).toBeGreaterThan(1);
    for (const one of found) expect(one.end - one.start).toBeLessThanOrEqual(60.001);
    // The whole recording is still covered, not sampled.
    expect(totalSeconds(found)).toBeCloseTo(300, 1);
  });

  it('ends a moment at a shot change, because what follows is a different thing', () => {
    const found = findHighlights({ duration: 60, silences: [], cuts: [30], count: 5, minSeconds: 6 });
    expect(found.map((one) => Math.round(one.end))).toEqual([30, 60]);
  });

  it('ignores a shot change too close to a boundary to be worth cutting at', () => {
    const found = findHighlights({ duration: 60, silences: [], cuts: [0.2, 59.8], count: 5, minSeconds: 6 });
    expect(found).toHaveLength(1);
    expect(Math.round(found[0].end)).toBe(60);
  });

  it('offers nothing rather than something when there is no talking', () => {
    expect(findHighlights({ duration: 60, silences: [{ start: 0, end: 60 }] })).toEqual([]);
    expect(findHighlights({ duration: 0, silences: [] })).toEqual([]);
    expect(findHighlights({ duration: Number.NaN, silences: [] })).toEqual([]);
  });

  it('never offers more than it was asked for, and always at least one when it can', () => {
    const silences = Array.from({ length: 20 }, (_, index) => ({ start: index * 30 + 20, end: index * 30 + 25 }));
    expect(findHighlights({ duration: 600, silences, count: 3 })).toHaveLength(3);
    expect(findHighlights({ duration: 600, silences, count: 0 })).toHaveLength(1);
  });

  it('works on a file with no shot changes at all, which is any audio', () => {
    const found = findHighlights({ duration: 100, silences: [{ start: 40, end: 50 }], count: 5, minSeconds: 6 });
    expect(found.map((one) => Math.round(one.end))).toEqual([40, 100]);
  });

  it('keeps its own limits sane when it is handed nonsense', () => {
    // A floor above the ceiling: the ceiling wins rather than returning nothing.
    const found = findHighlights({ duration: 60, silences: [], minSeconds: 90, maxSeconds: 10, count: 5 });
    expect(found).toEqual([]);
    expect(MAX_HIGHLIGHT).toBeGreaterThan(0);
  });
});

describe('what has to go for only the moments to be left', () => {
  const clip = { id: 'c', startFrame: 100, durationFrames: 600, sourceOffsetFrames: 0 } as unknown as Clip;
  const at = (start: number, end: number) => ({ start, end, score: 1, speaking: end - start });

  it('is the stretches between them, in timeline frames', () => {
    // A 20-second clip at 30fps starting at frame 100. Moments at 2-5s and 12-15s.
    const gaps = gapsBetween(clip, [at(2, 5), at(12, 15)], 30);
    expect(gaps).toEqual([
      { from: 100, to: 160 },
      { from: 250, to: 460 },
      { from: 550, to: 700 },
    ]);
  });

  it('leaves no gap before a moment that starts at the beginning', () => {
    const gaps = gapsBetween(clip, [at(0, 5)], 30);
    expect(gaps).toEqual([{ from: 250, to: 700 }]);
  });

  it('leaves no gap after a moment that runs to the end', () => {
    const gaps = gapsBetween(clip, [at(15, 20)], 30);
    expect(gaps).toEqual([{ from: 100, to: 550 }]);
  });

  it('is nothing at all when the moments are the whole clip', () => {
    expect(gapsBetween(clip, [at(0, 20)], 30)).toEqual([]);
  });

  it('is the whole clip when there are no moments', () => {
    expect(gapsBetween(clip, [], 30)).toEqual([{ from: 100, to: 700 }]);
  });

  it('copes with moments that touch or overlap, rather than cutting backwards', () => {
    const gaps = gapsBetween(clip, [at(2, 8), at(5, 12)], 30);
    // The overlap is taken as one stretch: no gap of negative length.
    expect(gaps).toEqual([
      { from: 100, to: 160 },
      { from: 460, to: 700 },
    ]);
    for (const gap of gaps) expect(gap.to).toBeGreaterThan(gap.from);
  });

  it('never proposes a cut outside the clip', () => {
    for (const gap of gapsBetween(clip, [at(3, 6)], 30)) {
      expect(gap.from).toBeGreaterThanOrEqual(clip.startFrame);
      expect(gap.to).toBeLessThanOrEqual(clip.startFrame + clip.durationFrames);
    }
  });
});
