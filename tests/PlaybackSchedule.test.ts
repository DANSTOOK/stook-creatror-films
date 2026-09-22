import { describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import {
  advanceScheduled,
  forgetPassed,
  planPlaybackSpans,
  type ScheduledSpan,
} from '@renderer/audio/playbackSchedule';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * Deciding what to decode and sound next while playing.
 *
 * This is the half of streamed playback that can be tested without an audio
 * device, and it is the half that decides whether a 45-minute source costs
 * the same as a short one.
 */

/** One project, and its own tracks - track ids differ between projects. */
function setup() {
  const base = createEmptyProject();
  return {
    base,
    audio: base.tracks.find((track) => track.type === 'audio')!,
    video: base.tracks.find((track) => track.type === 'video')!,
  };
}

const withClips = (base: ProjectState, ...clips: Clip[]): ProjectState => ({
  ...base,
  clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
});

const options = (overrides: Partial<Parameters<typeof planPlaybackSpans>[1]> = {}) => ({
  fromSeconds: 0,
  horizonSeconds: 2,
  chunkSeconds: 1,
  scheduledUntil: new Map<string, number>(),
  canStream: () => true,
  ...overrides,
});

describe('planPlaybackSpans', () => {
  it('schedules only as far as the horizon, however long the clip is', () => {
    const { base, audio } = setup();
    // 45 minutes at 30 fps.
    const clip = createClip({ trackId: audio.id, name: 'long', sourceUri: 'media://a', startFrame: 0, durationFrames: 30 * 60 * 45 });
    const spans = planPlaybackSpans(withClips(base, clip), options());
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => [s.atTimeline, s.seconds])).toEqual([[0, 1], [1, 1]]);
  });

  it('reads the right place in the source, trimming included', () => {
    const { base, audio } = setup();
    const clip = createClip({ trackId: audio.id, name: 'trimmed', sourceUri: 'media://a', startFrame: 60, durationFrames: 120 });
    // Starts 3 s into its source (90 frames at 30 fps).
    clip.sourceOffsetFrames = 90;
    const spans = planPlaybackSpans(withClips(base, clip), options({ fromSeconds: 2.5, horizonSeconds: 1, chunkSeconds: 1 }));
    // The clip begins at timeline 2 s, so 2.5 s is 0.5 s into it: 3.5 s into the source.
    expect(spans).toHaveLength(1);
    expect(spans[0].sourceFrom).toBeCloseTo(3.5, 6);
    expect(spans[0].atTimeline).toBeCloseTo(2.5, 6);
  });

  it('starts a clip at its own beginning, not at the playhead', () => {
    const { base, audio } = setup();
    const clip = createClip({ trackId: audio.id, name: 'later', sourceUri: 'media://a', startFrame: 45, durationFrames: 120 });
    const spans = planPlaybackSpans(withClips(base, clip), options({ fromSeconds: 0, horizonSeconds: 3, chunkSeconds: 5 }));
    expect(spans[0].atTimeline).toBeCloseTo(1.5, 6);
    expect(spans[0].sourceFrom).toBeCloseTo(0, 6);
  });

  it('stops at the end of a clip', () => {
    const { base, audio } = setup();
    const clip = createClip({ trackId: audio.id, name: 'short', sourceUri: 'media://a', startFrame: 0, durationFrames: 45 });
    const spans = planPlaybackSpans(withClips(base, clip), options({ horizonSeconds: 5, chunkSeconds: 5 }));
    expect(spans).toHaveLength(1);
    expect(spans[0].seconds).toBeCloseTo(1.5, 6);
  });

  it('does not schedule the same stretch twice', () => {
    const { base, audio } = setup();
    const clip = createClip({ trackId: audio.id, name: 'a', sourceUri: 'media://a', startFrame: 0, durationFrames: 300 });
    const state = withClips(base, clip);

    const first = planPlaybackSpans(state, options({ fromSeconds: 0, horizonSeconds: 2, chunkSeconds: 1 }));
    const marks = advanceScheduled(new Map(), first);
    expect(marks.get(clip.id)).toBeCloseTo(2, 6);

    // A moment later, with the same horizon reaching further.
    const second = planPlaybackSpans(state, options({ fromSeconds: 0.5, horizonSeconds: 2, chunkSeconds: 1, scheduledUntil: marks }));
    expect(second.map((s) => s.atTimeline)).toEqual([2]);
    expect(second[0].seconds).toBeCloseTo(0.5, 6);
  });

  it('leaves out muted tracks, and everything unsoloed while something is soloed', () => {
    const { base, audio, video } = setup();
    const music = createClip({ trackId: audio.id, name: 'music', sourceUri: 'media://m', startFrame: 0, durationFrames: 120 });
    const film = createClip({ trackId: video.id, name: 'film', sourceUri: 'media://f', startFrame: 0, durationFrames: 120 });
    const state = withClips(base, music, film);

    const muted = { ...state, tracks: state.tracks.map((t) => (t.id === audio.id ? { ...t, muted: true } : t)) };
    expect(planPlaybackSpans(muted, options()).map((s) => s.clipId)).toEqual([film.id, film.id]);

    const soloed = { ...state, tracks: state.tracks.map((t) => (t.id === audio.id ? { ...t, solo: true } : t)) };
    expect(new Set(planPlaybackSpans(soloed, options()).map((s) => s.clipId))).toEqual(new Set([music.id]));
  });

  it('leaves out sources that cannot be streamed', () => {
    const { base, audio } = setup();
    const a = createClip({ trackId: audio.id, name: 'aac', sourceUri: 'media://aac', startFrame: 0, durationFrames: 120 });
    const b = createClip({ trackId: audio.id, name: 'wav', sourceUri: 'media://wav', startFrame: 0, durationFrames: 120 });
    const spans = planPlaybackSpans(withClips(base, a, b), options({ canStream: (uri) => uri === 'media://aac' }));
    expect(new Set(spans.map((s) => s.clipId))).toEqual(new Set([a.id]));
  });

  it('hands the spans over in the order they will sound', () => {
    const { base, audio, video } = setup();
    const first = createClip({ trackId: audio.id, name: 'first', sourceUri: 'media://a', startFrame: 0, durationFrames: 30 });
    const second = createClip({ trackId: video.id, name: 'second', sourceUri: 'media://b', startFrame: 15, durationFrames: 30 });
    const spans = planPlaybackSpans(withClips(base, first, second), options({ horizonSeconds: 3, chunkSeconds: 5 }));
    expect(spans.map((s) => s.atTimeline)).toEqual([0, 0.5]);
  });
});

describe('keeping track of what is scheduled', () => {
  const span = (clipId: string, atTimeline: number, seconds: number): ScheduledSpan => ({
    clipId, sourceUri: 'media://a', sourceFrom: 0, seconds, rate: 1, atTimeline,
  });

  it('moves a clip mark forward, never back', () => {
    const marks = advanceScheduled(new Map([['a', 5]]), [span('a', 1, 1)]);
    expect(marks.get('a')).toBe(5);
  });

  it('forgets clips the playhead has passed, so a jump starts them afresh', () => {
    const marks = forgetPassed(new Map([['done', 2], ['live', 9]]), 5);
    expect([...marks.keys()]).toEqual(['live']);
  });
});
