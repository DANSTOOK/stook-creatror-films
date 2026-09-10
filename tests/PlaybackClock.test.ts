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

  it('wraps to the start when looping', () => {
    const tick = advancePlayhead(
      options({ currentFrame: 995, durationFrames: 1000, loop: true }),
      1,
      0,
    );
    expect(tick.frame).toBe(0);
    expect(tick.stopped).toBe(false);
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
