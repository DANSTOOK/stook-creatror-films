import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import { currentLoopRange, insideLoop, loopRangeOf } from '@renderer/timing/loopRange';
import { loopPassAt, wrapLoopSeconds } from '@renderer/audio/AudioEngine';
import { advanceScheduled, planPlaybackSpans } from '@renderer/audio/playbackSchedule';
import { audioClockAction, driftRoundLoop } from '@renderer/audio/audioClock';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Loop playback: what it goes round, and how the sound is laid out so the
 * join is seamless.
 */

function withClips(...clips: Array<[number, number]>): { project: ProjectState; ids: string[] } {
  const project = createEmptyProject(1920, 1080, 30);
  const track = project.tracks.find((candidate) => candidate.type === 'audio')!;
  const made: Clip[] = clips.map(([start, length]) => createClip({ trackId: track.id, name: 'c', sourceUri: 'blob:tone', startFrame: start, durationFrames: length }));
  return { project: { ...project, clips: Object.fromEntries(made.map((clip) => [clip.id, clip])) }, ids: made.map((clip) => clip.id) };
}

const none = { inFrame: null, outFrame: null, selectedClipIds: [] as string[] };

describe('what the loop goes round', () => {
  it('In to Out when marked', () => {
    const { project } = withClips([0, 300]);
    expect(loopRangeOf(project, { ...none, inFrame: 30, outFrame: 90 })).toEqual({ start: 30, end: 90, source: 'marks' });
    // One mark: from it to the end of the edit, or from the start to it.
    expect(loopRangeOf(project, { ...none, inFrame: 30 })).toEqual({ start: 30, end: 300, source: 'marks' });
    expect(loopRangeOf(project, { ...none, outFrame: 90 })).toEqual({ start: 0, end: 90, source: 'marks' });
  });

  it('else the selected clips, first start to last end', () => {
    const { project, ids } = withClips([0, 60], [100, 40], [200, 50]);
    expect(loopRangeOf(project, { ...none, selectedClipIds: [ids[1], ids[2]] })).toEqual({ start: 100, end: 250, source: 'selection' });
    // Marks win over the selection.
    expect(loopRangeOf(project, { inFrame: 10, outFrame: 20, selectedClipIds: [ids[1]] }).source).toBe('marks');
  });

  it('else the whole edit - to the end of the last clip, not the canvas', () => {
    const { project } = withClips([0, 60], [100, 470]);
    expect(project.durationFrames).toBe(1800);
    expect(loopRangeOf(project, none)).toEqual({ start: 0, end: 570, source: 'timeline' });
    // An empty edit loops the canvas rather than nothing.
    expect(loopRangeOf(createEmptyProject(), none).end).toBe(1800);
  });

  it('is remembered between frames while nothing it depends on changes', () => {
    const { project, ids } = withClips([0, 60]);
    const ui = { ...none, selectedClipIds: [ids[0]] };
    expect(currentLoopRange(project, ui)).toBe(currentLoopRange(project, ui));
    expect(insideLoop({ start: 10, end: 20 }, 20)).toBe(false);
    expect(insideLoop({ start: 10, end: 20 }, 10)).toBe(true);
  });
});

describe('starting playback with the loop on', () => {
  const state = () => useProjectStore.getState();
  beforeEach(() => state().newProject(1920, 1080, 30));

  it('starts at the loop start when the playhead is outside it, and plays on from inside', () => {
    const track = state().project.tracks.find((candidate) => candidate.type === 'audio')!;
    state().addClip({ trackId: track.id, name: 'c', sourceUri: 'blob:tone', startFrame: 0, durationFrames: 300 });
    state().setUi({ loopPlayback: true, inFrame: 60, outFrame: 120 });
    state().setCurrentFrame(200);
    state().setPlaying(true);
    expect(state().project.currentFrame).toBe(60);
    state().setPlaying(false);
    state().setCurrentFrame(90);
    state().setPlaying(true);
    expect(state().project.currentFrame).toBe(90);
    state().setPlaying(false);
  });
});

describe('the sound round the loop', () => {
  const loop = { start: 1, end: 3 };

  it('wraps play time into the loop and counts the times round', () => {
    expect(wrapLoopSeconds(2.5, loop)).toBe(2.5);
    expect(wrapLoopSeconds(3, loop)).toBe(1);
    expect(wrapLoopSeconds(4.25, loop)).toBeCloseTo(2.25, 12);
    expect(wrapLoopSeconds(9, null)).toBe(9);
    expect([0.5, 2.99, 3, 4.99, 5, 7].map((t) => loopPassAt(t, loop))).toEqual([0, 0, 1, 1, 2, 3]);
  });

  it('plans nothing past the loop end: a clip over it is cut exactly there', () => {
    const { project } = withClips([0, 300]);
    const spans = planPlaybackSpans(project, {
      fromSeconds: 2.2,
      horizonSeconds: 2,
      chunkSeconds: 0.5,
      scheduledUntil: new Map(),
      canStream: () => true,
      endSeconds: 3,
    });
    const end = Math.max(...spans.map((span) => span.atTimeline + span.seconds));
    expect(end).toBeCloseTo(3, 12);
    // Nothing missing between where planning started and the join.
    expect(spans.reduce((sum, span) => sum + span.seconds, 0)).toBeCloseTo(0.8, 12);
  });

  it('lays a whole buffer in one span to the loop end: no joins inside a pass', () => {
    const { project } = withClips([0, 300]);
    const spans = planPlaybackSpans(project, {
      fromSeconds: 1,
      horizonSeconds: 0.4,
      chunkSeconds: 0.5,
      scheduledUntil: new Map(),
      canStream: () => true,
      whole: () => true,
      endSeconds: 3,
    });
    expect(spans).toHaveLength(1);
    expect([spans[0].atTimeline, spans[0].seconds, spans[0].sourceFrom]).toEqual([1, 2, 1]);
    // And it is not planned again on the next tick.
    const again = planPlaybackSpans(project, {
      fromSeconds: 1.2,
      horizonSeconds: 2,
      chunkSeconds: 0.5,
      scheduledUntil: advanceScheduled(new Map(), spans),
      canStream: () => true,
      whole: () => true,
      endSeconds: 3,
    });
    expect(again).toEqual([]);
  });

  it('streamed spans of each pass meet edge to edge: the second pass starts where the loop starts', () => {
    const { project } = withClips([0, 300]);
    // The second time round plans from the loop start again, as the engine does.
    const pass = planPlaybackSpans(project, { fromSeconds: 1, horizonSeconds: 2, chunkSeconds: 0.5, scheduledUntil: new Map(), canStream: () => true, endSeconds: 3 });
    expect(pass[0].atTimeline).toBe(1);
    expect(pass[0].sourceFrom).toBe(1);
    for (let i = 1; i < pass.length; i += 1) expect(pass[i].atTimeline).toBeCloseTo(pass[i - 1].atTimeline + pass[i - 1].seconds, 12);
    expect(pass.at(-1)!.atTimeline + pass.at(-1)!.seconds).toBeCloseTo(3, 12);
  });
});

describe('the resync check round a loop', () => {
  it('takes the shorter way round: a frame either side of the join is a frame, not a whole loop', () => {
    // Picture just wrapped to 1.00 s, sound still at 2.99 s of a 1-3 s loop.
    expect(driftRoundLoop(1.0 - 2.99, 2)).toBeCloseTo(0.01, 12);
    expect(driftRoundLoop(2.99 - 1.0, 2)).toBeCloseTo(-0.01, 12);
    // A real move of the playhead stays a move.
    expect(driftRoundLoop(0.8, 2)).toBe(0.8);
    expect(driftRoundLoop(-1.9, null)).toBe(-1.9);
    // And so a wrap is not read as a scrub, while a move still is.
    expect(audioClockAction('running', driftRoundLoop(1.0 - 2.99, 2), 0, 0.35)).toBe('none');
    expect(audioClockAction('running', driftRoundLoop(0.8, 2), 0, 0.35)).toBe('resync');
  });
});
