import { describe, expect, it } from 'vitest';

import {
  MAX_SPEED,
  MIN_SPEED,
  audioFollowsSpeed,
  clampSpeed,
  durationForSpeed,
  maxDurationAtSpeed,
  retimed,
  sourceFrameFor,
  sourceFramesUsed,
  speedForDuration,
  speedLabel,
} from '@renderer/timing/clipSpeed';
import { createClip } from '@renderer/store/types';
import type { Clip } from '@shared/types';

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  ...createClip({
    trackId: 'v1',
    name: 'shot.mp4',
    sourceUri: 'media://shot',
    startFrame: 100,
    durationFrames: 120,
  }),
  ...overrides,
});

describe('speed and duration, the way the Speed/Duration dialog ties them', () => {
  it('halves the clip at 200% and doubles it at 50%, showing the same footage', () => {
    const original = clip();
    const fast = retimed(original, { speed: 2, reversed: false }, 600);
    const slow = retimed(original, { speed: 0.5, reversed: false }, 600);

    expect(fast.durationFrames).toBe(60);
    expect(slow.durationFrames).toBe(240);
    expect(sourceFramesUsed(fast)).toBe(120);
    expect(sourceFramesUsed(slow)).toBe(120);
  });

  it('is reversible: back to 100% is the length it started with', () => {
    const there = retimed(clip(), { speed: 4, reversed: false }, 600);
    const back = retimed(there, { speed: 1, reversed: false }, 600);
    expect(back.durationFrames).toBe(120);
  });

  it('works out the speed that makes footage fill a length - the Rate Stretch sum', () => {
    expect(speedForDuration(120, 60)).toBe(2);
    expect(speedForDuration(120, 240)).toBe(0.5);
    expect(durationForSpeed(120, speedForDuration(120, 75))).toBe(75);
  });

  it('keeps the speed inside what the app will do', () => {
    expect(clampSpeed(0)).toBe(MIN_SPEED);
    expect(clampSpeed(50)).toBe(MAX_SPEED);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it('cannot slow a clip past the end of its own footage', () => {
    // 120 frames used from frame 500 of a 600-frame file: at half speed it
    // would want 240, but only 100 frames of film are left.
    const near = clip({ sourceOffsetFrames: 500 });
    expect(maxDurationAtSpeed(near, 0.5, 600)).toBe(200);
    expect(retimed(near, { speed: 0.5, reversed: false }, 600).durationFrames).toBe(200);
  });

  it('lets a still be held for as long as anyone likes', () => {
    expect(maxDurationAtSpeed(clip(), 0.5, undefined)).toBeUndefined();
    expect(retimed(clip(), { speed: 0.5, reversed: false }, undefined).durationFrames).toBe(240);
  });
});

describe('which frame of footage is shown', () => {
  it('holds each frame twice at half speed', () => {
    const slow = { ...clip({ sourceOffsetFrames: 0 }), speed: 0.5 };
    expect(sourceFrameFor(slow, 100)).toBe(0);
    expect(sourceFrameFor(slow, 101)).toBe(1);
    expect(sourceFrameFor(slow, 102)).toBe(1);
    expect(sourceFrameFor(slow, 104)).toBe(2);
  });

  it('skips every other one at double speed', () => {
    const fast = { ...clip({ sourceOffsetFrames: 0 }), speed: 2 };
    expect(sourceFrameFor(fast, 100)).toBe(0);
    expect(sourceFrameFor(fast, 101)).toBe(2);
    expect(sourceFrameFor(fast, 110)).toBe(20);
  });

  it('starts from the trimmed-in point, not from the top of the file', () => {
    const trimmed = { ...clip({ sourceOffsetFrames: 300 }), speed: 2 };
    expect(sourceFrameFor(trimmed, 100)).toBe(300);
    expect(sourceFrameFor(trimmed, 105)).toBe(310);
  });

  it('runs backwards from the last frame when reversed', () => {
    const back = { ...clip({ sourceOffsetFrames: 0, durationFrames: 10 }), reversed: true };
    expect(sourceFrameFor(back, 100)).toBe(9);
    expect(sourceFrameFor(back, 104)).toBe(5);
    expect(sourceFrameFor(back, 109)).toBe(0);
  });

  it('reverses at another speed too, from the last frame it covers', () => {
    const back = { ...clip({ sourceOffsetFrames: 50, durationFrames: 10 }), speed: 2, reversed: true };
    expect(sourceFramesUsed(back)).toBe(20);
    expect(sourceFrameFor(back, 100)).toBe(69);
    expect(sourceFrameFor(back, 109)).toBe(51);
  });

  it('leaves a clip at normal speed exactly where it always was', () => {
    // The mapping every other part of the engine has used: offset + elapsed.
    const plain = clip({ sourceOffsetFrames: 40 });
    for (const frame of [100, 123, 219]) {
      expect(sourceFrameFor(plain, frame)).toBe(40 + (frame - 100));
    }
  });
});

describe('what the clip says about itself', () => {
  it('shows nothing at normal speed, and the percentage otherwise', () => {
    expect(speedLabel(clip())).toBeNull();
    expect(speedLabel({ ...clip(), speed: 2 })).toBe('200%');
    expect(speedLabel({ ...clip(), speed: 0.25 })).toBe('25%');
    expect(speedLabel({ ...clip(), speed: 0.125 })).toBe('12.5%');
    expect(speedLabel({ ...clip(), reversed: true })).toBe('◀ 100%');
  });

  it('says the sound can follow another speed, but not backwards', () => {
    expect(audioFollowsSpeed({ ...clip(), speed: 2 })).toBe(true);
    expect(audioFollowsSpeed({ ...clip(), reversed: true })).toBe(false);
  });
});
