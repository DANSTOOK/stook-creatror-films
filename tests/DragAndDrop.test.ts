import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset, ProjectState } from '@shared/types';
import { planDrop, trackTypeFor, type DroppedAsset } from '@renderer/components/Timeline/dropPlacement';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Dropping media onto the timeline.
 *
 * The rules that decide where a drop lands are pure (`planDrop`), so they are
 * pinned down here rather than discovered by dragging files around.
 */

const state = () => useProjectStore.getState();

const video = (id: string, durationFrames = 60): DroppedAsset => ({ id, kind: 'video', durationFrames });
const audio = (id: string, durationFrames = 60): DroppedAsset => ({ id, kind: 'audio', durationFrames });
const image = (id: string, durationFrames = 150): DroppedAsset => ({ id, kind: 'image', durationFrames });

/** Empty project: Video 1, Video 2, Audio 1. */
function project(): ProjectState & { v1: string; v2: string; a1: string } {
  const base = createEmptyProject();
  const [v1, v2, a1] = base.tracks.map((track) => track.id);
  return { ...base, v1, v2, a1 };
}

function withClip(p: ProjectState, trackId: string, startFrame: number, durationFrames: number): ProjectState {
  const clip = createClip({ trackId, name: 'x', sourceUri: 'blob:x', startFrame, durationFrames });
  return { ...p, clips: { ...p.clips, [clip.id]: clip } };
}

describe('planDrop', () => {
  it('lands where it was dropped, on the track under the pointer', () => {
    const p = project();
    const [placement] = planDrop(p, [video('a')], p.v2, 90);
    expect(placement).toMatchObject({ trackId: p.v2, startFrame: 90 });
  });

  it('puts stills on a video track, like video', () => {
    expect(trackTypeFor('image')).toBe('video');
    const p = project();
    expect(planDrop(p, [image('i')], p.v1, 0)[0].trackId).toBe(p.v1);
  });

  it('reroutes audio dropped on a video track to an audio track', () => {
    const p = project();
    const [placement] = planDrop(p, [audio('s')], p.v1, 30);
    expect(placement).toMatchObject({ trackId: p.a1, startFrame: 30 });
  });

  it('lines several dropped files up one after another', () => {
    const p = project();
    const placements = planDrop(p, [video('a', 60), video('b', 40), video('c', 20)], p.v1, 100);
    expect(placements.map((entry) => entry.startFrame)).toEqual([100, 160, 200]);
  });

  // Point 8: planDrop keeps the drop point; what the clip would cover is
  // settled by insertIntoTrack when it is placed (tests/StrictSequence.test.ts).
  it('keeps the drop point even over a clip, for the insertion to settle', () => {
    const p = project();
    const occupied = withClip(p, p.v1, 50, 100); // frames 50-150
    const [placement] = planDrop(occupied, [video('a', 30)], p.v1, 80);
    expect(placement.startFrame).toBe(80);
  });

  it('slips into a gap that is big enough', () => {
    const p = project();
    let occupied = withClip(p, p.v1, 0, 50);
    occupied = withClip(occupied, p.v1, 200, 50);
    const [placement] = planDrop(occupied, [video('a', 60)], p.v1, 60);
    expect(placement.startFrame).toBe(60);
  });

  it('keeps a drop into a gap too small for it where it was dropped', () => {
    const p = project();
    let occupied = withClip(p, p.v1, 0, 50);
    occupied = withClip(occupied, p.v1, 70, 50); // gap 50-70 is only 20 long
    const [placement] = planDrop(occupied, [video('a', 60)], p.v1, 50);
    // Not pushed past the next clip any more: inserted here, it moves along.
    expect(placement.startFrame).toBe(50);
  });

  it('does not drop onto a locked track', () => {
    const p = project();
    const locked = { ...p, tracks: p.tracks.map((t) => (t.id === p.v1 ? { ...t, locked: true } : t)) };
    expect(planDrop(locked, [video('a')], p.v1, 0)[0].trackId).toBe(p.v2);
  });

  it('asks for a new track when no compatible one exists', () => {
    const p = project();
    const noAudio = { ...p, tracks: p.tracks.filter((t) => t.id !== p.a1) };
    const placements = planDrop(noAudio, [audio('s1', 30), audio('s2', 30)], p.v1, 10);
    expect(placements.every((entry) => entry.trackId === null && entry.trackType === 'audio')).toBe(true);
    // Both bound for the same new track still follow one another.
    expect(placements.map((entry) => entry.startFrame)).toEqual([10, 40]);
  });

  it('clamps a drop left of the timeline start to frame 0', () => {
    const p = project();
    expect(planDrop(p, [video('a')], p.v1, -25)[0].startFrame).toBe(0);
  });
});

describe('placing dropped media through the store', () => {
  const asset = (id: string, kind: MediaAsset['kind'] = 'video', durationFrames = 60): MediaAsset => ({
    id,
    name: `${id}.mp4`,
    uri: `blob:${id}`,
    kind,
    durationFrames,
    width: 1920,
    height: 1080,
    hasAlphaChannel: false,
  });

  beforeEach(() => {
    useProjectStore.getState().newProject();
    useHistoryStore.getState().clear();
  });

  it('makes a multi-file drop ONE undo step', () => {
    const assets = [asset('a'), asset('b'), asset('c')];
    const trackId = state().project.tracks[0].id;
    state().placeAssets(assets, planDrop(state().project, assets, trackId, 0));
    expect(Object.keys(state().project.clips)).toHaveLength(3);

    state().undo();
    expect(Object.keys(state().project.clips)).toHaveLength(0);
  });

  it('selects what was just dropped', () => {
    const assets = [asset('a'), asset('b')];
    const ids = state().placeAssets(assets, planDrop(state().project, assets, null, 0));
    expect(state().ui.selectedClipIds).toEqual(ids);
  });

  it('creates the missing track in the same undo step', () => {
    const videoOnly = state().project.tracks.filter((t) => t.type === 'video');
    useProjectStore.setState({ project: { ...state().project, tracks: videoOnly } });

    const music = [asset('m', 'audio')];
    state().placeAssets(music, planDrop(state().project, music, null, 0));
    expect(state().project.tracks.filter((t) => t.type === 'audio')).toHaveLength(1);

    state().undo();
    expect(state().project.tracks.filter((t) => t.type === 'audio')).toHaveLength(0);
  });
});

describe('first import into an empty project', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
  });

  it('keeps the clip its real length when the project adopts a new frame rate', () => {
    // A 4 second, 60 fps clip, measured while the project was still at 30 fps.
    state().addAssets([
      {
        id: 'a',
        name: 'sixty.mp4',
        uri: 'blob:sixty',
        kind: 'video',
        durationFrames: 120, // 4 s at the 30 fps the import ran under
        width: 1920,
        height: 1080,
        hasAlphaChannel: false,
        sourceFps: 60,
      },
    ]);

    expect(state().project.fps).toBe(60);
    // 4 seconds at 60 fps. It used to stay at 120, i.e. land at half length.
    expect(state().assets[0].durationFrames).toBe(240);
  });

  it('leaves later imports alone, once the rate is settled', () => {
    state().addAssets([
      { id: 'a', name: 'a.mp4', uri: 'blob:a', kind: 'video', durationFrames: 240, width: 1920, height: 1080, hasAlphaChannel: false, sourceFps: 60 },
    ]);
    state().addAssets([
      { id: 'b', name: 'b.mp4', uri: 'blob:b', kind: 'video', durationFrames: 90, width: 1920, height: 1080, hasAlphaChannel: false, sourceFps: 60 },
    ]);
    expect(state().assets.find((a) => a.id === 'b')?.durationFrames).toBe(90);
  });
});
