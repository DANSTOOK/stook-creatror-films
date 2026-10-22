import { describe, expect, it } from 'vitest';
import { cameraPath, coverScale, positionFor, reframedSize, subjectCentre } from '@renderer/edit/reframe';

function matteWith(width: number, height: number, box: { x0: number; x1: number; y0: number; y1: number }): Uint8Array {
  const matte = new Uint8Array(width * height);
  for (let y = box.y0; y < box.y1; y += 1) for (let x = box.x0; x < box.x1; x += 1) matte[y * width + x] = 255;
  return matte;
}

describe('where the person is', () => {
  it('is the middle of what the matte marks', () => {
    const found = subjectCentre(matteWith(200, 100, { x0: 140, x1: 180, y0: 20, y1: 100 }), 200, 100);
    expect(found?.x).toBeCloseTo(0.8, 1);
    expect(found?.y).toBeCloseTo(0.6, 1);
  });

  it('is nobody when the matte is empty or a speck', () => {
    expect(subjectCentre(new Uint8Array(200 * 100), 200, 100)).toBeNull();
    expect(subjectCentre(matteWith(200, 100, { x0: 10, x1: 12, y0: 10, y1: 12 }), 200, 100)).toBeNull();
  });
});

describe('the virtual camera', () => {
  const shot = 0.316; // 9:16 out of 16:9
  const steady = (x: number | null, seconds: number) => Array.from({ length: seconds * 5 }, (_, i) => ({ t: i / 5, x }));

  it('holds still while the person only shifts a little', () => {
    const samples = steady(0.5, 2).map((sample, i) => ({ ...sample, x: 0.5 + (i % 2 ? 0.02 : -0.02) }));
    const path = cameraPath(samples, shot);
    expect(new Set(path.map((point) => point.x.toFixed(4))).size).toBe(1);
  });

  it('follows smoothly when they walk across, without jumping', () => {
    const samples = Array.from({ length: 40 }, (_, i) => ({ t: i / 5, x: 0.3 + (0.4 * i) / 39 }));
    const path = cameraPath(samples, shot);
    const steps = path.slice(1).map((point, i) => Math.abs(point.x - path[i].x));
    expect(Math.max(...steps)).toBeLessThan(0.05);
    expect(path.at(-1)!.x).toBeGreaterThan(0.6);
  });

  it('stays where it was when nobody is in the frame, and never runs the shot off the picture', () => {
    const samples = [...steady(0.95, 2), ...steady(null, 2)];
    const path = cameraPath(samples, shot);
    const half = shot / 2;
    expect(path.every((point) => point.x <= 1 - half + 1e-9 && point.x >= half - 1e-9)).toBe(true);
    expect(path.at(-1)!.x).toBeCloseTo(path[9].x, 2);
  });
});

describe('filling the new frame', () => {
  it('a 16:9 picture covers a 9:16 frame without being stretched', () => {
    const scale = coverScale(16 / 9, 9 / 16);
    expect(scale.y).toBe(1);
    expect(scale.x).toBeCloseTo(256 / 81, 6);
  });

  it('the position puts the subject in the middle, but never shows an edge', () => {
    const drawn = 1080 * (256 / 81);
    expect(positionFor(0.5, drawn, 1080)).toBe(0);
    expect(positionFor(0.6, drawn, 1080)).toBeCloseTo(-0.1 * drawn, 6);
    // At the very edge, only as far as the picture reaches.
    expect(positionFor(1, drawn, 1080)).toBeCloseTo(-(drawn - 1080) / 2, 6);
  });

  it('a 1920x1080 project becomes 1080x1920, 1080x1080 or 1080x1350', () => {
    expect(reframedSize(1920, 1080, { w: 9, h: 16 })).toEqual({ width: 1080, height: 1920 });
    expect(reframedSize(1920, 1080, { w: 1, h: 1 })).toEqual({ width: 1080, height: 1080 });
    expect(reframedSize(1920, 1080, { w: 4, h: 5 })).toEqual({ width: 1080, height: 1350 });
  });
});
