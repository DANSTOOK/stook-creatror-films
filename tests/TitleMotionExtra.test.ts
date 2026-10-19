import { describe, expect, it } from 'vitest';
import type { TitleAnimation } from '@shared/types';
import { SLIDE, TRAVEL, ZOOM_BY, ZOOM_FROM, titleAnimationAt } from '@renderer/text/animation';
import {
  hasTextMotion,
  isTextEntrance,
  isTextExit,
  staggered,
  textMotionAt,
  typedCount,
  unitOf,
  unitStateAt,
  wholeStateAt,
} from '@renderer/text/textMotion';

/**
 * The entrances and exits the title library added: the ones that move the
 * whole title (text/animation) and the ones that redraw its letters
 * (text/textMotion), frame by frame, without a GPU.
 */

const FPS = 30;
const H = 1080;
const anim = (patch: Partial<TitleAnimation>): TitleAnimation => ({ in: 'none', inSeconds: 0.5, out: 'none', outSeconds: 0.33, roll: false, ...patch });

describe('the new whole-title entrances', () => {
  it('Fall comes down from above as it fades', () => {
    const fall = anim({ in: 'fall' });
    expect(titleAnimationAt(fall, 0, 150, FPS, H).offset.y).toBeCloseTo(-TRAVEL * H, 9);
    expect(titleAnimationAt(fall, 15, 150, FPS, H).offset.y).toBe(0);
  });

  it('Slide from left starts to the left and arrives', () => {
    const slide = anim({ in: 'fromLeft' });
    expect(titleAnimationAt(slide, 0, 150, FPS, H).offset.x).toBeCloseTo(-SLIDE * H, 9);
    expect(titleAnimationAt(slide, 15, 150, FPS, H).offset.x).toBe(0);
  });

  it('Zoom starts larger and settles to 1 without a bounce', () => {
    const zoom = anim({ in: 'zoom' });
    const frames = Array.from({ length: 16 }, (_, at) => titleAnimationAt(zoom, at, 150, FPS, H).scale);
    expect(frames[0]).toBeCloseTo(ZOOM_FROM, 6);
    expect(frames[15]).toBe(1);
    // Never overshoots below 1: a push in, not a pop.
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});

describe('the new whole-title exits', () => {
  it('Lift rises away as it fades', () => {
    const lift = anim({ out: 'lift' });
    expect(titleAnimationAt(lift, 150, 150, FPS, H).offset.y).toBeCloseTo(-TRAVEL * H, 6);
    expect(titleAnimationAt(lift, 140, 150, FPS, H).offset.y).toBeGreaterThan(-TRAVEL * H);
  });

  it('Zoom out grows as it goes', () => {
    const zoom = anim({ out: 'zoom' });
    expect(titleAnimationAt(zoom, 150, 150, FPS, H).scale).toBeCloseTo(1 + ZOOM_BY, 6);
  });

  it('Slide to right leaves to the right', () => {
    const slide = anim({ out: 'toRight' });
    expect(titleAnimationAt(slide, 150, 150, FPS, H).offset.x).toBeCloseTo(SLIDE * H, 6);
  });
});

describe('the letter-by-letter entrances and exits', () => {
  it('names which redraw the letters', () => {
    expect(isTextEntrance('typewriter')).toBe(true);
    expect(isTextEntrance('fade')).toBe(false);
    expect(isTextExit('blur')).toBe(true);
    expect(isTextExit('drop')).toBe(false);
    expect(hasTextMotion(anim({ in: 'letters' }))).toBe(true);
    expect(hasTextMotion(anim({ in: 'fade', out: 'drop' }))).toBe(false);
    expect(hasTextMotion(anim({ in: 'typewriter', roll: true }))).toBe(false);
  });

  it('picks the unit each works in', () => {
    expect(unitOf('typewriter')).toBe('grapheme');
    expect(unitOf('words')).toBe('word');
    expect(unitOf('lines')).toBe('line');
    expect(unitOf('blur')).toBe('whole');
  });

  it('is present only during the entrance or exit, and null at rest between', () => {
    const a = anim({ in: 'letters', inSeconds: 0.5, out: 'words', outSeconds: 0.33 });
    expect(textMotionAt(a, 0, 150, FPS)?.phase).toBe('in');
    expect(textMotionAt(a, 7, 150, FPS)?.phase).toBe('in'); // 15 frames in
    expect(textMotionAt(a, 75, 150, FPS)).toBeNull(); // at rest in the middle
    expect(textMotionAt(a, 149, 150, FPS)?.phase).toBe('out');
    expect(textMotionAt(undefined, 0, 150, FPS)).toBeNull();
    // A rolling title never redraws its letters.
    expect(textMotionAt(anim({ in: 'letters', roll: true }), 0, 150, FPS)).toBeNull();
  });

  it('staggers pieces so the first starts at 0 and the last ends at 1', () => {
    expect(staggered(0, 0, 5, 0.4)).toBe(0);
    expect(staggered(1, 4, 5, 0.4)).toBe(1);
    // A later piece lags an earlier one.
    expect(staggered(0.5, 3, 5, 0.4)).toBeLessThan(staggered(0.5, 0, 5, 0.4));
    // One piece: it simply follows the progress.
    expect(staggered(0.3, 0, 1, 0.4)).toBeCloseTo(0.3, 9);
  });

  it('Typewriter shows more letters as it goes in, and fewer as it goes out', () => {
    const inMotion = textMotionAt(anim({ in: 'typewriter' }), 0, 150, FPS)!;
    expect(typedCount({ ...inMotion, progress: 0 }, 10)).toBe(0);
    expect(typedCount({ ...inMotion, progress: 1 }, 10)).toBe(10);
    expect(typedCount({ ...inMotion, progress: 0.5 }, 10)).toBe(5);
    const outMotion = { ...inMotion, phase: 'out' as const };
    expect(typedCount({ ...outMotion, progress: 0 }, 10)).toBe(10);
    expect(typedCount({ ...outMotion, progress: 1 }, 10)).toBe(0);
  });

  it('brings each letter on from below as it fades in, and settles it', () => {
    const motion = { phase: 'in' as const, kind: 'letters' as const, progress: 1, key: 'k' };
    const first = unitStateAt(motion, 0, 4);
    expect(first.opacity).toBeCloseTo(1, 6);
    expect(first.dy).toBeCloseTo(0, 6);
    const early = unitStateAt({ ...motion, progress: 0 }, 3, 4);
    expect(early.opacity).toBe(0);
    expect(early.dy).toBeGreaterThan(0);
  });

  it('blurs and clears the whole text, and never leaves a stuck caret', () => {
    const blurIn = { phase: 'in' as const, kind: 'blur' as const, progress: 0, key: 'k' };
    expect(wholeStateAt(blurIn).blur).toBeGreaterThan(0);
    expect(wholeStateAt({ ...blurIn, progress: 1 }).blur).toBeCloseTo(0, 6);
    const typing = { phase: 'in' as const, kind: 'typewriter' as const, progress: 0.5, key: 'k' };
    expect(wholeStateAt(typing).caret).toBe(true);
    expect(wholeStateAt({ ...typing, progress: 1 }).caret).toBe(false);
  });
});
