import { describe, expect, it } from 'vitest';
import { WAKE_INTERVAL_MS, audioClockAction } from '@renderer/audio/audioClock';

/**
 * A suspended AudioContext (no device, sleep, a device change) made the
 * playback hook rebuild the whole audio graph three times a second against a
 * clock that was not moving: 6 rebuilds in 2 s, measured in the running app
 * on v1.41 (tests/ui/playhead-layers). These pin what it does instead.
 */

const THRESHOLD = 0.35;

describe('the audio clock check', () => {
  it('a running clock that has fallen behind the playhead is scheduled again', () => {
    expect(audioClockAction('running', 0.5, 0, THRESHOLD)).toBe('resync');
    expect(audioClockAction('running', -0.5, 0, THRESHOLD)).toBe('resync');
  });

  it('a running clock in step is left alone', () => {
    expect(audioClockAction('running', 0.1, 0, THRESHOLD)).toBe('none');
  });

  it('a suspended clock is never rescheduled against, however far behind it is', () => {
    expect(audioClockAction('suspended', 30, 0, THRESHOLD)).toBe('wait');
  });

  it('a suspended clock is asked to run again, at most once a second', () => {
    expect(audioClockAction('suspended', 30, WAKE_INTERVAL_MS - 1, THRESHOLD)).toBe('wait');
    expect(audioClockAction('suspended', 30, WAKE_INTERVAL_MS, THRESHOLD)).toBe('wake');
    // Two suspended seconds at 60 frames a second: two requests, not 120.
    let lastWake = 0;
    let wakes = 0;
    for (let frame = 0; frame <= 120; frame += 1) {
      const now = Math.round((frame * 1000) / 60);
      if (audioClockAction('suspended', 1, now - lastWake, THRESHOLD) === 'wake') {
        wakes += 1;
        lastWake = now;
      }
    }
    expect(wakes).toBe(2);
  });

  it('a closed clock is not woken or rescheduled', () => {
    expect(audioClockAction('closed', 30, 5000, THRESHOLD)).toBe('wait');
  });
});
