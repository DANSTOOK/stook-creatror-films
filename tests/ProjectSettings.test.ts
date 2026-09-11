import { beforeEach, describe, expect, it } from 'vitest';
import { retimeProject } from '@renderer/components/Timeline/timelineOps';
import { createClip, createEmptyProject, normalizeProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Project settings, and the frame-rate change underneath them.
 *
 * Frame numbers are meaningless without the rate that reads them, so changing
 * `fps` by assignment silently re-times the whole edit. `retimeProject` is the
 * arithmetic that keeps a cut authored at four seconds at four seconds, and it
 * is the part worth testing: everything else in the panel is a plain field.
 */

const state = () => useProjectStore.getState();

const seconds = (frames: number, fps: number): number => frames / fps;

function projectWithClip(fps: number) {
  const base = createEmptyProject(1920, 1080, fps);
  const clip = createClip({
    trackId: base.tracks[0].id,
    name: 'Take',
    sourceUri: 'blob:take',
    startFrame: 4 * fps, // Four seconds in.
    durationFrames: 2 * fps, // Two seconds long.
    sourceOffsetFrames: fps,
  });

  return {
    ...base,
    currentFrame: fps,
    clips: { [clip.id]: clip },
    markers: [{ id: 'marker-1', frame: 3 * fps, label: 'Cue', color: '#facc15' }],
    clipId: clip.id,
  };
}

describe('retimeProject', () => {
  it('keeps clips at the same wall-clock position and length', () => {
    const before = projectWithClip(30);
    const after = retimeProject(before, 60);
    const clip = after.clips[before.clipId];

    expect(after.fps).toBe(60);
    expect(seconds(clip.startFrame, 60)).toBeCloseTo(4);
    expect(seconds(clip.durationFrames, 60)).toBeCloseTo(2);
  });

  it('moves the source offset with the clip, so the trim still points at the same media', () => {
    const before = projectWithClip(30);
    const clip = retimeProject(before, 60).clips[before.clipId];

    expect(seconds(clip.sourceOffsetFrames, 60)).toBeCloseTo(1);
  });

  it('carries the playhead, the duration and the markers', () => {
    const after = retimeProject(projectWithClip(30), 60);

    expect(seconds(after.currentFrame, 60)).toBeCloseTo(1);
    expect(seconds(after.durationFrames, 60)).toBeCloseTo(60);
    expect(seconds(after.markers[0].frame, 60)).toBeCloseTo(3);
  });

  it('rescales keyframes, which are stored in timeline time', () => {
    const before = projectWithClip(30);
    const withKeyframe: typeof before = {
      ...before,
      clips: {
        [before.clipId]: {
          ...before.clips[before.clipId],
          transform: {
            ...before.clips[before.clipId].transform,
            opacity: [{ id: 'kf-1', frame: 150, value: 0.5, easing: 'linear' as const }],
          },
        },
      },
    };

    const after = retimeProject(withKeyframe, 60);
    expect(after.clips[before.clipId].transform.opacity[0].frame).toBe(300);
  });

  it('never rounds a clip away to nothing', () => {
    const base = createEmptyProject(1920, 1080, 60);
    const short = createClip({
      trackId: base.tracks[0].id,
      name: 'Blink',
      sourceUri: 'blob:blink',
      startFrame: 0,
      durationFrames: 1,
    });

    const after = retimeProject({ ...base, clips: { [short.id]: short } }, 24);
    // 1 frame at 60 fps scales to 0.4 frames at 24. Rounding that down would
    // delete the clip outright.
    expect(after.clips[short.id].durationFrames).toBe(1);
  });

  it('is a no-op when the rate has not changed', () => {
    const before = projectWithClip(25);
    const after = retimeProject(before, 25);

    expect(after.clips[before.clipId].startFrame).toBe(before.clips[before.clipId].startFrame);
  });

  it('refuses a nonsensical rate rather than dividing by it', () => {
    const before = projectWithClip(30);
    expect(retimeProject(before, 0).fps).toBe(30);
    expect(retimeProject(before, Number.NaN).fps).toBe(30);
  });
});

describe('setProjectSettings', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
  });

  it('retimes the edit by default', () => {
    const id = state().addClip({
      trackId: state().project.tracks[0].id,
      name: 'Take',
      sourceUri: 'blob:take',
      startFrame: 120, // Four seconds at 30 fps.
      durationFrames: 60,
    });

    state().setProjectSettings({ fps: 60 });
    expect(state().project.clips[id].startFrame).toBe(240);
  });

  it('leaves frame numbers alone when retiming is declined', () => {
    const id = state().addClip({
      trackId: state().project.tracks[0].id,
      name: 'Take',
      sourceUri: 'blob:take',
      startFrame: 120,
      durationFrames: 60,
    });

    state().setProjectSettings({ fps: 60 }, false);
    expect(state().project.clips[id].startFrame).toBe(120);
    expect(state().project.fps).toBe(60);
  });

  it('keeps the export settings in step with the project', () => {
    state().setProjectSettings({ width: 1280, height: 720 });

    expect(state().exportSettings.width).toBe(1280);
    expect(state().exportSettings.height).toBe(720);
  });

  it('is undoable', () => {
    state().setProjectSettings({ width: 1280, height: 720 });
    state().undo();

    expect(state().project.width).toBe(1920);
  });
});

describe('normalizeProject', () => {
  /** A project file written before the mixer and markers existed. */
  const legacy = () => {
    const project = createEmptyProject(1920, 1080, 30) as unknown as Record<string, unknown>;
    const tracks = (project.tracks as Record<string, unknown>[]).map((track) => {
      const { volume, pan, solo, bus, ...rest } = track;
      void volume;
      void pan;
      void solo;
      void bus;
      return rest;
    });

    const { markers, audio, ...rest } = project;
    void markers;
    void audio;
    return { ...rest, tracks } as never;
  };

  it('fills the mixer fields with values that reproduce the old behaviour', () => {
    const normalized = normalizeProject(legacy());

    expect(normalized.audio.masterVolume).toBe(1);
    expect(normalized.audio.ducking.enabled).toBe(false);
    for (const track of normalized.tracks) {
      expect(track.volume).toBe(1);
      expect(track.pan).toBe(0);
      expect(track.solo).toBe(false);
    }
  });

  it('derives the bus from the track name, the way version 1 did at playback time', () => {
    const project = createEmptyProject();
    const renamed = {
      ...project,
      tracks: project.tracks.map((track, index) => ({
        ...track,
        name: index === 0 ? 'Dialogue 1' : track.name,
        bus: undefined as never,
      })),
    };

    const normalized = normalizeProject(renamed);
    expect(normalized.tracks[0].bus).toBe('dialogue');
    expect(normalized.tracks[1].bus).toBe('music');
  });

  it('gives a project with no markers an empty list rather than undefined', () => {
    expect(normalizeProject(legacy()).markers).toEqual([]);
  });

  it('sorts markers it does find', () => {
    const project = createEmptyProject();
    const normalized = normalizeProject({
      ...project,
      markers: [
        { id: 'b', frame: 90, label: 'B', color: '#fff' },
        { id: 'a', frame: 10, label: 'A', color: '#fff' },
      ],
    });

    expect(normalized.markers.map((marker) => marker.id)).toEqual(['a', 'b']);
  });
});
