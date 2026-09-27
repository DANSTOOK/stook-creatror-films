import { describe, expect, it } from 'vitest';
import type { ColorGradingConfig } from '@shared/types';
import {
  cdlOf,
  gradePixel,
  neutralWheel,
  normalizeGrading,
  puckOf,
  wheelChroma,
  wheelMaster,
  withMaster,
  withPuck,
  type Rgb,
} from '@renderer/color/grade';
import { createClip, normalizeProject, createEmptyProject } from '@renderer/store/types';

const NEUTRAL: ColorGradingConfig = normalizeGrading({ enabled: true });
const graded = (patch: Partial<ColorGradingConfig>): ColorGradingConfig => ({ ...NEUTRAL, ...patch });
const all = (value: number): Rgb => [value, value, value];

/** Within half an 8-bit level: tighter than the +-1/255 the GPU is held to. */
const close = (actual: Rgb, expected: Rgb): void => {
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThan(0.5 / 255));
};

describe('the primaries as an ASC CDL', () => {
  it('is the identity, and switched off, when every wheel is neutral', () => {
    const cdl = cdlOf(NEUTRAL);
    expect(cdl.active).toBe(false);
    expect(cdl.slope).toEqual([1, 1, 1]);
    expect(cdl.offset).toEqual([0, 0, 0]);
    expect(cdl.power).toEqual([1, 1, 1]);
  });

  it('writes lift/gamma/gain/offset as slope = gain - lift, offset = lift + offset, power = gamma', () => {
    const cdl = cdlOf(graded({ lift: all(0.2), gain: all(0.5), gamma: all(1), offset: all(-0.4) }));
    expect(cdl.active).toBe(true);
    cdl.slope.forEach((value) => expect(value).toBeCloseTo(1.5 - 0.1, 12));
    cdl.offset.forEach((value) => expect(value).toBeCloseTo(0.1 - 0.2, 12));
    cdl.power.forEach((value) => expect(value).toBeCloseTo(0.5, 12));
  });
});

describe('known colours through the grade', () => {
  it('leaves every level alone when neutral', () => {
    for (let level = 0; level <= 255; level += 1) close(gradePixel(all(level / 255), NEUTRAL), all(level / 255));
  });

  it('gain doubles: a quarter becomes a half, black stays black', () => {
    const grade = graded({ gain: all(1) });
    close(gradePixel(all(0.25), grade), all(0.5));
    close(gradePixel(all(0), grade), all(0));
  });

  it('lift raises black and leaves white where it is', () => {
    const grade = graded({ lift: all(1) });
    close(gradePixel(all(0), grade), all(0.5));
    close(gradePixel(all(1), grade), all(1));
    close(gradePixel(all(0.5), grade), all(0.75));
  });

  it('gamma bends the middle with both ends fixed', () => {
    const grade = graded({ gamma: all(1) });
    close(gradePixel(all(0.25), grade), all(0.5));
    close(gradePixel(all(0), grade), all(0));
    close(gradePixel(all(1), grade), all(1));
  });

  it('offset moves everything, clipped at the ends', () => {
    const grade = graded({ offset: all(0.2) });
    close(gradePixel(all(0.2), grade), all(0.3));
    close(gradePixel(all(0.95), grade), all(1));
  });

  it('contrast turns about the pivot', () => {
    const grade = graded({ contrast: 2, pivot: 0.25 });
    close(gradePixel(all(0.25), grade), all(0.25));
    close(gradePixel(all(0.3), grade), all(0.35));
  });

  it('saturation 0 is BT.709 luma', () => {
    const grey = gradePixel([1, 0, 0], graded({ saturation: 0 }));
    close(grey, all(0.2126));
  });

  it('a red lift warms the shadows only', () => {
    const grade = graded({ lift: [0.4, 0, 0] });
    const shadow = gradePixel(all(0.1), grade);
    const white = gradePixel(all(1), grade);
    expect(shadow[0]).toBeGreaterThan(shadow[1]);
    close(white, all(1));
  });
});

describe('a wheel: puck and brightness', () => {
  it('puts the puck in the vectorscope plane: up is toward red, right toward blue', () => {
    const up = withPuck(neutralWheel(), 0, 0.5);
    expect(up[0]).toBeGreaterThan(up[1]);
    expect(up[0]).toBeGreaterThan(up[2]);
    const right = withPuck(neutralWheel(), 0.5, 0);
    expect(right[2]).toBeGreaterThan(right[0]);
  });

  it('moving the puck never changes the brightness, and back again', () => {
    const wheel = withPuck(withMaster(neutralWheel(), 0.3), -0.4, 0.25);
    expect(wheelMaster(wheel)).toBeCloseTo(0.3, 12);
    const puck = puckOf(wheel);
    expect(puck.x).toBeCloseTo(-0.4, 12);
    expect(puck.y).toBeCloseTo(0.25, 12);
  });

  it('the brightness slider never changes the colour', () => {
    const wheel = withPuck(neutralWheel(), 0.3, 0.3);
    const brighter = withMaster(wheel, 0.2);
    expect(wheelChroma(brighter).cb).toBeCloseTo(wheelChroma(wheel).cb, 12);
    expect(wheelChroma(brighter).cr).toBeCloseTo(wheelChroma(wheel).cr, 12);
  });

  it('keeps the puck inside the rim', () => {
    const puck = puckOf(withPuck(neutralWheel(), 3, 4));
    expect(Math.hypot(puck.x, puck.y)).toBeCloseTo(1, 12);
  });
});

describe('projects saved before the wheels', () => {
  it('open with them neutral and everything else as saved', () => {
    const old = { enabled: true, exposure: 0.5, contrast: 1.2, saturation: 0.8, temperature: 0.1, tint: -0.1, lutIntensity: 0.7 };
    const grading = normalizeGrading(old as Partial<ColorGradingConfig>);
    expect(grading).toMatchObject(old);
    expect(grading.pivot).toBe(0.5);
    for (const wheel of [grading.lift, grading.gamma, grading.gain, grading.offset]) expect(wheel).toEqual([0, 0, 0]);
    expect(cdlOf(grading).active).toBe(false);
  });

  it('are filled in when the project opens', () => {
    const project = createEmptyProject();
    const clip = createClip({ trackId: project.tracks[0].id, name: 'a', sourceUri: 'x', startFrame: 0, durationFrames: 10 });
    const { lift: _l, gamma: _g, gain: _n, offset: _o, pivot: _p, ...oldGrade } = clip.colorGrading;
    const opened = normalizeProject({ ...project, clips: { [clip.id]: { ...clip, colorGrading: oldGrade as ColorGradingConfig } } });
    expect(opened.clips[clip.id].colorGrading).toEqual(clip.colorGrading);
  });
});
