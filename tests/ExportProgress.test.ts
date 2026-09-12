import { describe, expect, it } from 'vitest';
import { describeExportProgress, formatClock } from '@renderer/components/ExportDialog/exportProgress';

describe('formatClock', () => {
  it('writes minutes and seconds, and hours only when there are some', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(19 * 60 + 27.72)).toBe('19:28');
    expect(formatClock(3600 + 62)).toBe('1:01:02');
  });

  it('never prints nonsense for a bad value', () => {
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
  });
});

describe('the export progress bar', () => {
  // The user's render: 19:27 of video at 30 fps.
  const total = 35032;

  it('speaks in minutes of video, not frames', () => {
    const view = describeExportProgress({ frame: 8250, totalFrames: total, renderFps: 110, projectFps: 30 });
    expect(view.videoDone).toBe('4:35');
    expect(view.videoTotal).toBe('19:28');
    expect(view.percent).toBe(23.5);
  });

  it('says how long the render has run and how long it still needs', () => {
    const view = describeExportProgress({ frame: 8250, totalFrames: total, renderFps: 110, projectFps: 30 });
    expect(view.elapsed).toBe('1:15');
    // (35032 - 8250) / 110 = 243.5 s
    expect(view.remaining).toBe('4:03');
    expect(view.speed).toBeCloseTo(110 / 30, 5);
  });

  it('makes no promise from the first few frames', () => {
    expect(describeExportProgress({ frame: 3, totalFrames: total, renderFps: 400, projectFps: 30 }).remaining).toBeNull();
    expect(describeExportProgress({ frame: 0, totalFrames: total, renderFps: 0, projectFps: 30 }).remaining).toBeNull();
  });

  it('reaches exactly 100% and nothing left at the end', () => {
    const view = describeExportProgress({ frame: total, totalFrames: total, renderFps: 300, projectFps: 30 });
    expect(view.percent).toBe(100);
    expect(view.remaining).toBe('0:00');
  });

  it('does not run past the end or below zero on odd counters', () => {
    expect(describeExportProgress({ frame: total + 50, totalFrames: total, renderFps: 300, projectFps: 30 }).percent).toBe(100);
    expect(describeExportProgress({ frame: -4, totalFrames: total, renderFps: 300, projectFps: 30 }).percent).toBe(0);
    expect(describeExportProgress({ frame: 0, totalFrames: 0, renderFps: 0, projectFps: 30 }).percent).toBe(0);
  });
});
