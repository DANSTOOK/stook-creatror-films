import { describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import { subjectCentre, subjectHead } from '@renderer/edit/reframe';
import { DEFAULT_AUTO_FRAME, TIGHTNESS, framePath, planAutoFrame, type HeadSample } from '@renderer/edit/autoFrame';

/**
 * Auto framing: the head found in a matte, the camera's path, and the
 * keyframes that come of it. The pictures are judged in the running app
 * (tests/ui/auto-frame.mjs); here, the decisions.
 */

/**
 * A matte of a person: a head `headWidth` wide at the top centred on `headX`,
 * and a wider body below it centred on `bodyX` - both 0..1 across.
 */
function personMatte(width: number, height: number, headX: number, bodyX: number, headWidth = 0.14, bodyWidth = 0.4): Uint8Array {
  const matte = new Uint8Array(width * height);
  const band = (fromY: number, toY: number, centre: number, span: number): void => {
    for (let y = Math.round(fromY * height); y < Math.round(toY * height); y += 1) {
      for (let x = Math.round((centre - span / 2) * width); x < Math.round((centre + span / 2) * width); x += 1) {
        if (x >= 0 && x < width) matte[y * width + x] = 255;
      }
    }
  };
  band(0.1, 0.3, headX, headWidth);
  band(0.3, 0.95, bodyX, bodyWidth);
  return matte;
}

const project = { width: 1920, height: 1080, fps: 30 } as ProjectState;
const clip = { id: 'c1', startFrame: 100, durationFrames: 90 } as Clip;
const asset = { width: 1920, height: 1080 };

describe('finding the head in a matte', () => {
  it('finds the head, not the middle of the person', () => {
    // The head is well to the left of the body, so the two answers must differ.
    const matte = personMatte(160, 90, 0.3, 0.6);
    const head = subjectHead(matte, 160, 90);
    const centre = subjectCentre(matte, 160, 90);
    expect(head).not.toBeNull();
    expect(head!.x).toBeCloseTo(0.3, 1);
    expect(head!.y).toBeLessThan(0.3);
    // The middle of the mass is pulled down and across by the body.
    expect(centre!.x).toBeGreaterThan(head!.x + 0.1);
    expect(centre!.y).toBeGreaterThan(head!.y + 0.2);
  });

  it('is not fooled by a band of noise above the person', () => {
    // A small subject low on the RIGHT, with a faint band across the top of the
    // frame - compression noise over a dark background. Reading the topmost row
    // that passes anywhere took the noise for the head, and the estimate stayed
    // on the left while the person was on the right (measured on a 1080p
    // fixture: the camera never panned).
    const width = 160;
    const height = 90;
    const matte = personMatte(width, height, 0.78, 0.78, 0.1, 0.22);
    for (let x = 0; x < width; x += 1) {
      for (let y = 2; y < 5; y += 1) matte[y * width + x] = 120;
    }
    const head = subjectHead(matte, width, height);
    expect(head).not.toBeNull();
    expect(head!.x).toBeCloseTo(0.78, 1);
    expect(head!.y).toBeGreaterThan(0.08);
  });

  it('finds nobody in an empty matte', () => {
    expect(subjectHead(new Uint8Array(160 * 90), 160, 90)).toBeNull();
  });

  it('lands where the middle would on a close-up that fills the frame', () => {
    // Head and body the same width and the whole height: there is no "top fifth"
    // that differs, so the two answers should agree across.
    const matte = personMatte(160, 90, 0.5, 0.5, 0.6, 0.6);
    const head = subjectHead(matte, 160, 90);
    expect(head!.x).toBeCloseTo(subjectCentre(matte, 160, 90)!.x, 1);
  });
});

describe('the camera’s path', () => {
  const shot = { width: 0.7, height: 0.7 };
  const samples = (count: number, x: number, y: number): HeadSample[] =>
    Array.from({ length: count }, (_unused, index) => ({ t: index * 0.2, x, y }));

  it('has no path without samples', () => {
    expect(framePath([], shot)).toEqual([]);
  });

  it('holds still while the head only shifts inside the dead zone', () => {
    const nudged: HeadSample[] = samples(10, 0.5, 0.5).map((sample, index) => ({ ...sample, x: 0.5 + (index % 2 === 0 ? 0.01 : -0.01) }));
    const path = framePath(nudged, shot);
    const spread = Math.max(...path.map((point) => point.x)) - Math.min(...path.map((point) => point.x));
    expect(spread).toBeLessThan(0.005);
  });

  it('eases towards the head rather than snapping to it', () => {
    const moved: HeadSample[] = samples(12, 0.5, 0.5).map((sample, index) => (index < 2 ? sample : { ...sample, x: 0.8 }));
    const path = framePath(moved, shot, { ...DEFAULT_AUTO_FRAME, deadZone: 0.02, settleSeconds: 1 });
    // The step right after the move is a fraction of the way, not all of it.
    const step = path[2].x - path[1].x;
    expect(step).toBeGreaterThan(0.01);
    expect(step).toBeLessThan(0.3 * 0.8);
    // And it does arrive.
    expect(path[path.length - 1].x).toBeGreaterThan(0.6);
  });

  it('never points where the frame would run off the picture', () => {
    const path = framePath(samples(10, 0.98, 0.98), shot, { ...DEFAULT_AUTO_FRAME, deadZone: 0 });
    for (const point of path) {
      expect(point.x).toBeLessThanOrEqual(1 - shot.width / 2 + 1e-9);
      expect(point.y).toBeLessThanOrEqual(1 - shot.height / 2 + 1e-9);
    }
  });

  it('holds where it was when nobody is there', () => {
    const gone: HeadSample[] = [...samples(4, 0.3, 0.5), ...samples(6, null as unknown as number, null as unknown as number).map((sample) => ({ ...sample, x: null, y: null }))];
    const path = framePath(gone, shot, { ...DEFAULT_AUTO_FRAME, deadZone: 0 });
    expect(path[path.length - 1].x).toBeCloseTo(path[3].x, 2);
  });

  it('puts the head above the middle, with headroom', () => {
    const path = framePath(samples(20, 0.5, 0.4), shot, { ...DEFAULT_AUTO_FRAME, deadZone: 0, headroom: 0.3 });
    // Wanting the head 30 % down the frame means aiming the camera BELOW it.
    expect(path[path.length - 1].y).toBeGreaterThan(0.4);
  });
});

describe('planning the keyframes', () => {
  const samples: HeadSample[] = Array.from({ length: 16 }, (_unused, index) => ({ t: index * 0.2, x: 0.3 + index * 0.02, y: 0.35 }));

  it('gives one size that pushes the clip in, and keyframes inside the overhang', () => {
    const plan = planAutoFrame(project, clip, asset, samples, { ...DEFAULT_AUTO_FRAME, tightness: TIGHTNESS.standard });
    expect(plan).not.toBeNull();
    expect(plan!.scale).toHaveLength(1);
    expect(plan!.scale[0].value.x).toBeCloseTo(TIGHTNESS.standard, 5);
    expect(plan!.shot.width).toBeCloseTo(1 / TIGHTNESS.standard, 5);
    const overhang = (project.width * TIGHTNESS.standard - project.width) / 2;
    for (const key of plan!.position) {
      expect(Math.abs(key.value.x)).toBeLessThanOrEqual(overhang + 1e-6);
      expect(key.frame).toBeGreaterThanOrEqual(clip.startFrame);
      expect(key.frame).toBeLessThanOrEqual(clip.startFrame + clip.durationFrames - 1);
    }
  });

  it('does not tilt by default, and does when asked', () => {
    const flat = planAutoFrame(project, clip, asset, samples);
    expect(flat!.position.every((key) => key.value.y === 0)).toBe(true);
    const tilted = planAutoFrame(project, clip, asset, samples, { ...DEFAULT_AUTO_FRAME, tilt: true });
    expect(tilted!.position.some((key) => key.value.y !== 0)).toBe(true);
  });

  it('refuses when there is no room to pan', () => {
    // The clip already fills the frame exactly and is not pushed in at all.
    expect(planAutoFrame(project, clip, asset, samples, { ...DEFAULT_AUTO_FRAME, tightness: 1 })).toBeNull();
  });

  it('gives one keyframe at the clip’s start when the head never moves', () => {
    const still: HeadSample[] = Array.from({ length: 16 }, (_unused, index) => ({ t: index * 0.2, x: 0.5, y: 0.35 }));
    const plan = planAutoFrame(project, clip, asset, still);
    expect(plan!.position).toHaveLength(1);
    expect(plan!.position[0].frame).toBe(clip.startFrame);
  });

  it('refuses without samples or without the file’s size', () => {
    expect(planAutoFrame(project, clip, asset, [])).toBeNull();
    expect(planAutoFrame(project, clip, { width: 0, height: 0 }, samples)).toBeNull();
  });
});
