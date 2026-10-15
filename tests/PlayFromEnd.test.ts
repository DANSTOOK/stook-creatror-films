import { describe, expect, it } from 'vitest';
import { playStartFrame } from '@renderer/hooks/useTransport';

/**
 * "Space does not play, and stays that way until I change project."
 *
 * Reproduced in the running app: with the playhead parked at the end of the
 * timeline, pressing space starts playback and the clock stops it in the same
 * instant - the playhead is already past the last frame. Nothing on screen
 * says so, and every later press does the same, so the editor looks dead until
 * the project changes and the playhead goes back to the start.
 *
 * Play from the end means play again, as it does in every editor.
 */

describe('where playback starts', () => {
  it('rewinds when the playhead sits at the end', () => {
    expect(playStartFrame(9000, 9000, false)).toBe(0);
  });

  it('rewinds when it somehow sits past the end', () => {
    expect(playStartFrame(9001, 9000, false)).toBe(0);
  });

  it('rewinds from the last frame, which plays nothing either', () => {
    expect(playStartFrame(8999, 9000, false)).toBe(0);
  });

  it('carries on from wherever the playhead is', () => {
    expect(playStartFrame(0, 9000, false)).toBe(0);
    expect(playStartFrame(4500, 9000, false)).toBe(4500);
    expect(playStartFrame(8998, 9000, false)).toBe(8998);
  });

  it('leaves the playhead alone when looping, which wraps by itself', () => {
    expect(playStartFrame(9000, 9000, true)).toBe(9000);
  });

  it('does nothing strange with an empty timeline', () => {
    expect(playStartFrame(0, 0, false)).toBe(0);
  });
});
