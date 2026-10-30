import { describe, expect, it } from 'vitest';
import { LOOKAHEAD, MAX_CATCHUP_FRAMES, playbackPlan } from '@renderer/engine/PlaybackDecoder';

/**
 * What the playback decoder does with the playhead's frame.
 *
 * The whole point of the thing is that the frame is decoded BEFORE the draw
 * that wants it, so these check the read-ahead: that it runs ahead, that it
 * stops running ahead once it is far enough, and that a jump starts again
 * instead of decoding its way across the file.
 *
 * The arguments are the stretch the decoder holds, oldest to newest, and the
 * frame the playhead wants. Keeping both matters: reading ahead means the
 * newest is normally PAST the playhead, so judging "the playhead went back"
 * by the newest alone called every ordinary draw a jump - which the second
 * test here caught.
 */

describe('a decoder that has not started', () => {
  it('heads straight for the playhead', () => {
    expect(playbackPlan(-1, -1, 300)).toEqual({ restart: true, decodeTo: 300 });
  });
});

describe('playing forwards', () => {
  it('keeps a few frames decoded past the playhead', () => {
    expect(playbackPlan(100, 100, 100)).toEqual({ restart: false, decodeTo: 100 + LOOKAHEAD });
  });

  it('carries on while the read-ahead is in front of the playhead', () => {
    // Holding 100 to 106 with the playhead on 100: full, nothing to do.
    expect(playbackPlan(100, 100 + LOOKAHEAD, 100)).toEqual({ restart: false, decodeTo: null });
    // One frame on, and there is one more to decode.
    expect(playbackPlan(101, 100 + LOOKAHEAD, 101)).toEqual({ restart: false, decodeTo: 101 + LOOKAHEAD });
  });

  it('catches up by decoding on, when a dropped draw left it behind', () => {
    // Nothing held any more, the newest decoded is 100, the playhead is on 112.
    const plan = playbackPlan(100, 100, 112);
    expect(plan.restart).toBe(false);
    expect(plan.decodeTo).toBe(112 + LOOKAHEAD);
  });
});

describe('a jump', () => {
  it('back past what is held starts the decoder again, since going back means a keyframe anyway', () => {
    expect(playbackPlan(300, 306, 299)).toEqual({ restart: true, decodeTo: 299 });
  });

  it('back INTO what is held is served from it, not a restart', () => {
    expect(playbackPlan(300, 306, 302)).toEqual({ restart: false, decodeTo: 302 + LOOKAHEAD });
  });

  it('far forwards starts again rather than decode everything in between', () => {
    expect(playbackPlan(300, 300, 300 + MAX_CATCHUP_FRAMES)).toEqual({
      restart: true,
      decodeTo: 300 + MAX_CATCHUP_FRAMES,
    });
    // Just inside the gap is still playing, and walks.
    expect(playbackPlan(300, 300, 300 + MAX_CATCHUP_FRAMES - 1).restart).toBe(false);
  });

  it('half a second at 120 fps is the line', () => {
    expect(MAX_CATCHUP_FRAMES / 120).toBe(0.5);
  });
});
