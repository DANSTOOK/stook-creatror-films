import { afterEach, describe, expect, it } from 'vitest';
import { placeSpan, type PlacementInputs } from '@renderer/audio/playbackSchedule';
import { runPlaybackClock } from '@renderer/hooks/useTransport';
import { FrameRace, type FrameWindow } from '@renderer/timing/animationFrame';
import { clearPlaybackHold, heldClockFrom, holdPlayback, releasePlayback } from '@renderer/timing/playbackHold';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The start of play, and a span handed over late.
 *
 * Regression cover for a click measured on v1.42.0-beta.1 at nearly every
 * start of play part-way into a streamed sound, idle or loaded: the first
 * span was started on whatever sample it reached, part-way in when its decode
 * came late, while the picture had already set off. Now the playhead waits
 * for it, and sound that starts mid-way fades in.
 */

const FADE = 0.004;
const inputs = (overrides: Partial<PlacementInputs> = {}): PlacementInputs => ({
  when: 10,
  seconds: 0.5,
  earliest: 9.9,
  followsOn: false,
  startsMidSound: true,
  fadeSeconds: FADE,
  ...overrides,
});

describe('placeSpan', () => {
  it('starts a span on its moment when there is time', () => {
    expect(placeSpan(inputs({ startsMidSound: false }))).toEqual({ startAt: 10, skip: 0, fadeIn: false });
  });

  it('fades in a span that starts mid-sound after silence: the start of play part-way into a clip', () => {
    expect(placeSpan(inputs())).toEqual({ startAt: 10, skip: 0, fadeIn: true });
  });

  it('does not dip a span that carries straight on from the one before', () => {
    expect(placeSpan(inputs({ followsOn: true }))?.fadeIn).toBe(false);
  });

  it('starts a late span at the soonest safe moment, that far into itself, faded in', () => {
    const placed = placeSpan(inputs({ when: 10, earliest: 10.12, followsOn: true, startsMidSound: false }));
    expect(placed?.startAt).toBe(10.12);
    expect(placed?.skip).toBeCloseTo(0.12, 12);
    expect(placed?.fadeIn).toBe(true);
  });

  it('never starts a source at a time already gone, which would start it late and lay it over the next span', () => {
    for (const late of [0.001, 0.01, 0.2, 0.49]) {
      const placed = placeSpan(inputs({ when: 10, earliest: 10 + late }));
      expect(placed?.startAt).toBeGreaterThanOrEqual(10 + late);
      // It still ends where it was meant to: on the next span's moment.
      expect((placed?.startAt ?? 0) + (0.5 - (placed?.skip ?? 0))).toBeCloseTo(10.5, 12);
    }
  });

  it('drops what is left of a late span too short to fade in and out of', () => {
    expect(placeSpan(inputs({ when: 10, earliest: 10.495 }))).toBeNull();
    expect(placeSpan(inputs({ when: 10, earliest: 10.49 }))).not.toBeNull();
  });
});

describe('the playhead waiting for the sound', () => {
  afterEach(() => clearPlaybackHold());

  it('counts no time while held, and from the release once let go', () => {
    expect(heldClockFrom(100, 90)).toBe(90);
    holdPlayback();
    expect(heldClockFrom(120, 100)).toBeNull();
    releasePlayback(130);
    // Still before the moment the sound begins.
    expect(heldClockFrom(125, 120)).toBeNull();
    expect(heldClockFrom(140, 125)).toBe(130);
    // And then nothing holds it.
    expect(heldClockFrom(150, 140)).toBe(140);
  });

  it('a release with nothing held does nothing', () => {
    releasePlayback(500);
    expect(heldClockFrom(100, 90)).toBe(90);
  });
});

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
  frame(now: number): void {
    const due = [...this.queued.values()];
    this.queued.clear();
    for (const callback of due) callback(now);
  }
}

describe('the playback clock while the sound is made ready', () => {
  const state = () => useProjectStore.getState();
  const FRAME_MS = 1000 / 30;
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    clearPlaybackHold();
    state().setPlaying(false);
  });

  const playing = (): HandWindow => {
    state().newProject(1920, 1080, 30);
    const track = state().project.tracks[0];
    state().addClip({ trackId: track.id, name: 'c', sourceUri: 'media://c', startFrame: 0, durationFrames: 300 });
    state().setCurrentFrame(0);
    state().setPlaying(true);
    const editor = new HandWindow();
    const race = new FrameRace(editor);
    stop = runPlaybackClock({ request: (callback) => race.request(callback), cancel: (handle) => race.cancel(handle) }, 0);
    return editor;
  };

  it('stands still while held, then plays on from the release without jumping the wait', () => {
    holdPlayback();
    const editor = playing();
    for (let i = 1; i <= 9; i += 1) editor.frame(i * FRAME_MS);
    expect(state().project.currentFrame).toBe(0);
    // The sound begins 5 ms after the tenth frame; thirty frames on, the
    // playhead is thirty frames on from there - not thirty-nine.
    releasePlayback(9 * FRAME_MS + 5);
    for (let i = 10; i <= 39; i += 1) editor.frame(i * FRAME_MS);
    expect(state().project.currentFrame).toBeGreaterThanOrEqual(29);
    expect(state().project.currentFrame).toBeLessThanOrEqual(30);
  });

  it('runs at once when nothing holds it', () => {
    const editor = playing();
    for (let i = 1; i <= 30; i += 1) editor.frame(i * FRAME_MS);
    expect(state().project.currentFrame).toBeGreaterThanOrEqual(29);
  });
});
