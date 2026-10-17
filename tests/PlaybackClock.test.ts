import { describe, expect, it } from 'vitest';
import { advancePlayhead } from '@renderer/hooks/useTransport';

/**
 * The playback clock.
 *
 * Regression cover for a bug that shipped: the clock lived inside a hook that
 * two components called, so two rAF loops advanced the same playhead and
 * everything played at exactly double speed. The maths is pure now, and the
 * "one tick advances the playhead once" property is pinned here.
 */

const options = (overrides: Partial<Parameters<typeof advancePlayhead>[0]> = {}) => ({
  currentFrame: 0,
  durationFrames: 1000,
  fps: 30,
  loop: false,
  ...overrides,
});

describe('advancePlayhead', () => {
  it('advances one frame per frame interval', () => {
    const tick = advancePlayhead(options(), 1 / 30, 0);
    expect(tick.frame).toBe(1);
    expect(tick.stopped).toBe(false);
  });

  it('advances in real time, not per call', () => {
    // One second of elapsed time is 30 frames at 30 fps, however many ticks it
    // took to get there.
    const tick = advancePlayhead(options(), 1, 0);
    expect(tick.frame).toBe(30);
  });

  it('carries the fraction so a 60Hz display does not drift a 24fps timeline', () => {
    let frame = 0;
    let accumulator = 0;

    // 60 ticks of 1/60s = exactly one second.
    for (let i = 0; i < 60; i += 1) {
      const tick = advancePlayhead(options({ currentFrame: frame, fps: 24 }), 1 / 60, accumulator);
      frame = tick.frame;
      accumulator = tick.accumulator;
    }

    expect(frame).toBe(24);
  });

  it('holds the playhead when less than a frame has elapsed', () => {
    const tick = advancePlayhead(options({ currentFrame: 7 }), 0.001, 0);
    expect(tick.frame).toBe(7);
    expect(tick.accumulator).toBeGreaterThan(0);
  });

  it('accumulates sub-frame ticks until they add up to one frame', () => {
    let accumulator = 0;
    let frame = 0;

    for (let i = 0; i < 3; i += 1) {
      const tick = advancePlayhead(options({ currentFrame: frame }), 1 / 90, accumulator);
      frame = tick.frame;
      accumulator = tick.accumulator;
    }

    // Three ticks of 1/90s at 30fps is exactly one frame.
    expect(frame).toBe(1);
  });

  it('stops at the end rather than running past it', () => {
    const tick = advancePlayhead(options({ currentFrame: 995, durationFrames: 1000 }), 1, 0);
    expect(tick.frame).toBe(1000);
    expect(tick.stopped).toBe(true);
  });

  it('wraps exactly when looping: the frames past the end carry on from the start', () => {
    // 995 + 30 frames is 25 frames past the end. It used to snap to 0 and
    // drop those 25, so every time round the picture fell behind the sound.
    const tick = advancePlayhead(
      options({ currentFrame: 995, durationFrames: 1000, loop: true }),
      1,
      0,
    );
    expect(tick.frame).toBe(25);
    expect(tick.stopped).toBe(false);
  });

  it('goes round the loop it is given, not the canvas', () => {
    // In at 100, out at 160: 155 + 10 frames is 5 past the out point.
    const tick = advancePlayhead(options({ currentFrame: 155, loop: true, loopStart: 100, loopEnd: 160 }), 10 / 30, 0);
    expect(tick.frame).toBe(105);
    // Never shows the out frame itself: the range ends before it.
    const atEdge = advancePlayhead(options({ currentFrame: 159, loop: true, loopStart: 100, loopEnd: 160 }), 1 / 30, 0);
    expect(atEdge.frame).toBe(100);
  });

  it('keeps the fraction across the wrap, so going round does not drift', () => {
    let frame = 100;
    let accumulator = 0;
    // Half a frame a tick (exact in binary), 640 ticks: 320 frames on, round
    // a 64-frame loop exactly five times.
    for (let i = 0; i < 640; i += 1) {
      const tick = advancePlayhead(options({ currentFrame: frame, fps: 32, loop: true, loopStart: 100, loopEnd: 164 }), 1 / 64, accumulator);
      frame = tick.frame;
      accumulator = tick.accumulator;
    }
    expect(frame).toBe(100);
    expect(accumulator).toBe(0);
  });

  it('jumps into the loop when the playhead is past it', () => {
    const tick = advancePlayhead(options({ currentFrame: 400, loop: true, loopStart: 100, loopEnd: 160 }), 1 / 30, 0);
    expect(tick.frame).toBe(100);
  });

  it('goes round backwards too, from the start to the last frame', () => {
    const tick = advancePlayhead(options({ currentFrame: 101, loop: true, loopStart: 100, loopEnd: 160, rate: -1 }), 3 / 30, 0);
    // 101 - 3 = 98: two frames before the start is the second-to-last frame.
    expect(tick.frame).toBe(158);
  });

  it('ignores a negative elapsed time rather than running backwards', () => {
    const tick = advancePlayhead(options({ currentFrame: 40 }), -5, 0);
    expect(tick.frame).toBe(40);
  });

  it('scales with the project rate', () => {
    expect(advancePlayhead(options({ fps: 24 }), 1, 0).frame).toBe(24);
    expect(advancePlayhead(options({ fps: 25 }), 1, 0).frame).toBe(25);
    expect(advancePlayhead(options({ fps: 60 }), 1, 0).frame).toBe(60);
  });

  it('applied twice per interval advances twice - the double-speed bug', () => {
    // This is what two mounted clocks did to a single playhead. The guard in
    // usePlaybackClock exists so it cannot happen silently again.
    const first = advancePlayhead(options(), 1 / 30, 0);
    const second = advancePlayhead(options({ currentFrame: first.frame }), 1 / 30, 0);

    expect(second.frame).toBe(2);
  });
});
