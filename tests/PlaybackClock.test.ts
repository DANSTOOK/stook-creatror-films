import { afterEach, describe, expect, it, vi } from 'vitest';
import { advancePlayhead, runPlaybackClock } from '@renderer/hooks/useTransport';
import { FrameRace, type FrameWindow } from '@renderer/timing/animationFrame';
import { useProjectStore } from '@renderer/store/useProjectStore';

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

/*
  "A tick can no longer kill the clock", from the branch of 2026-10-02, checked
  against v1.41. The clock asked for its next frame at the end of each tick,
  so one exception on the way - thrown by anything the playhead's move
  notifies - ended the loop for good while the store still said "playing":
  Pause on screen, the playhead standing still. The frame source
  (timing/animationFrame FrameRace) catches and reports a callback that
  throws, so other loops go on - but a loop that never asked again stays
  stopped. These drive the real loop with the real FrameRace, frame by frame.
*/
class HandWindow implements FrameWindow {
  closed = false;
  readonly performance = { timeOrigin: 0 };
  private next = 1;
  private readonly queued = new Map<number, FrameRequestCallback>();
  requestAnimationFrame(callback: FrameRequestCallback): number {
    this.queued.set(this.next, callback);
    this.next += 1;
    return this.next - 1;
  }
  cancelAnimationFrame(handle: number): void {
    this.queued.delete(handle);
  }
  get waiting(): number {
    return this.queued.size;
  }
  frame(now: number): void {
    const due = [...this.queued.values()];
    this.queued.clear();
    for (const callback of due) callback(now);
  }
}

describe('the playback loop', () => {
  const state = () => useProjectStore.getState();
  const FRAME_MS = 1000 / 30;
  const offs: Array<() => void> = [];

  const playing = (): { editor: HandWindow; stop: () => void } => {
    state().newProject(1920, 1080, 30);
    const track = state().project.tracks[0];
    state().addClip({ trackId: track.id, name: 'c', sourceUri: 'media://c', startFrame: 0, durationFrames: 300 });
    state().setCurrentFrame(0);
    state().setPlaying(true);
    const editor = new HandWindow();
    const race = new FrameRace(editor);
    const stop = runPlaybackClock({ request: (callback) => race.request(callback), cancel: (handle) => race.cancel(handle) }, 0);
    offs.push(stop);
    return { editor, stop };
  };
  const run = (editor: HandWindow, from: number, count: number): void => {
    for (let i = from; i < from + count; i += 1) editor.frame(i * FRAME_MS);
  };

  afterEach(() => {
    for (const off of offs.splice(0)) off();
    state().setPlaying(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('moves the playhead one frame per frame of real time', () => {
    const { editor } = playing();
    run(editor, 1, 30);
    expect(state().project.currentFrame).toBeGreaterThanOrEqual(29);
    expect(state().project.currentFrame).toBeLessThanOrEqual(30);
  });

  it('keeps going when one tick throws', () => {
    // What FrameRace does with it: reported, and the other loops go on.
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { editor } = playing();
    let thrown = 0;
    offs.push(
      useProjectStore.subscribe((now) => {
        if (thrown === 0 && now.project.currentFrame > 5) {
          thrown += 1;
          throw new Error('test: one failing listener');
        }
      }),
    );
    run(editor, 1, 30);
    expect(thrown).toBe(1);
    expect(state().ui.isPlaying).toBe(true);
    expect(state().project.currentFrame).toBeGreaterThanOrEqual(29);
    expect(editor.waiting).toBe(1);
  });

  it('says so once per play, not once a frame, when every tick throws', () => {
    vi.stubGlobal('reportError', () => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { editor } = playing();
    offs.push(
      useProjectStore.subscribe(() => {
        throw new Error('test: a listener that always fails');
      }),
    );
    run(editor, 1, 30);
    expect(state().project.currentFrame).toBeGreaterThanOrEqual(29);
    expect(errors.mock.calls.filter(([message]) => String(message).includes('Playback clock'))).toHaveLength(1);
  });

  it('stops at the end, and asks for no more frames', () => {
    const { editor } = playing();
    state().setCurrentFrame(state().project.durationFrames - 3);
    run(editor, 1, 10);
    expect(state().ui.isPlaying).toBe(false);
    expect(state().project.currentFrame).toBe(state().project.durationFrames);
    expect(editor.waiting).toBe(0);
  });

  it('asks for nothing once it is stopped from outside', () => {
    const { editor, stop } = playing();
    run(editor, 1, 3);
    stop();
    expect(editor.waiting).toBe(0);
  });
});
