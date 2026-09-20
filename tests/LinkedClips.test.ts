import { beforeEach, describe, expect, it } from 'vitest';

import { useProjectStore } from '@renderer/store/useProjectStore';
import { normalizeProject } from '@renderer/store/types';
import type { Clip } from '@shared/types';

/**
 * Linked clips through the store: what an editor actually does to them.
 *
 * The pure rules live in LinkGroups.test.ts; this is the wiring - selecting,
 * moving, trimming, splitting and deleting a linked pair.
 */

const setUp = (): { video: string; title: string; videoTrack: string; titleTrack: string } => {
  const store = useProjectStore.getState();
  store.newProject();

  const state = useProjectStore.getState();
  const tracks = state.project.tracks.filter((track) => track.type === 'video');
  const [lower, upper] = [tracks[0], tracks[1] ?? tracks[0]];

  const video = store.addClip({
    trackId: lower.id,
    name: 'shot.mp4',
    sourceUri: 'media://shot',
    startFrame: 100,
    durationFrames: 200,
  });
  const title = useProjectStore.getState().addClip({
    trackId: upper.id,
    name: 'title.png',
    sourceUri: 'media://title',
    startFrame: 100,
    durationFrames: 200,
  });

  return { video, title, videoTrack: lower.id, titleTrack: upper.id };
};

const clipOf = (id: string): Clip => useProjectStore.getState().project.clips[id];

describe('linking two clips', () => {
  let ids: ReturnType<typeof setUp>;

  beforeEach(() => {
    ids = setUp();
    const store = useProjectStore.getState();
    store.selectClips([ids.video, ids.title]);
    store.linkSelection();
  });

  it('needs two clips: one on its own cannot be linked to itself', () => {
    const store = useProjectStore.getState();
    store.unlinkSelection();
    store.selectClips([ids.video]);
    store.linkSelection();
    expect(clipOf(ids.video).linkGroup).toBeUndefined();
  });

  it('makes clicking one of them select both', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.title]);
    expect(new Set(useProjectStore.getState().ui.selectedClipIds)).toEqual(
      new Set([ids.video, ids.title]),
    );
  });

  it('leaves Alt+click holding just the one clip, without breaking the link', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.title], false, true);
    expect(useProjectStore.getState().ui.selectedClipIds).toEqual([ids.title]);
    expect(clipOf(ids.title).linkGroup).toBeDefined();
  });

  it('moves both when one is moved, keeping the distance between them', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.video]);
    store.nudgeSelection(40, 0);
    expect(clipOf(ids.video).startFrame).toBe(140);
    expect(clipOf(ids.title).startFrame).toBe(140);
  });

  it('trims both edges by the same amount', () => {
    const store = useProjectStore.getState();
    store.trimClip(ids.video, 'end', 250);
    expect(clipOf(ids.video).durationFrames).toBe(150);
    expect(clipOf(ids.title).durationFrames).toBe(150);
  });

  it('stops a trim where the tightest of them stops', () => {
    // The title only has 60 frames of head room: the pair keeps its shape
    // rather than one of them running 40 frames further back than the other.
    const store = useProjectStore.getState();
    store.updateClip(ids.title, { sourceOffsetFrames: 60 });
    store.updateClip(ids.video, { sourceOffsetFrames: 100 });
    store.trimClip(ids.video, 'start', 0);

    expect(clipOf(ids.video).startFrame).toBe(40);
    expect(clipOf(ids.title).startFrame).toBe(40);
    expect(clipOf(ids.video).sourceOffsetFrames).toBe(40);
    expect(clipOf(ids.title).sourceOffsetFrames).toBe(0);
  });

  it('deletes both, and is one undo', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.video]);
    store.removeClips(useProjectStore.getState().ui.selectedClipIds);
    expect(Object.keys(useProjectStore.getState().project.clips)).toHaveLength(0);

    store.undo();
    expect(Object.keys(useProjectStore.getState().project.clips)).toHaveLength(2);
  });

  it('unlinks them again, and then they move alone', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.video]);
    store.unlinkSelection();

    store.selectClips([ids.video]);
    expect(useProjectStore.getState().ui.selectedClipIds).toEqual([ids.video]);
    store.nudgeSelection(40, 0);
    expect(clipOf(ids.video).startFrame).toBe(140);
    expect(clipOf(ids.title).startFrame).toBe(100);
  });

  it('cuts into two linked pairs, not one group of four', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.video]);
    store.razorAtFrame(200, useProjectStore.getState().ui.selectedClipIds);

    const clips = Object.values(useProjectStore.getState().project.clips);
    expect(clips).toHaveLength(4);

    const lefts = clips.filter((clip) => clip.startFrame === 100);
    const rights = clips.filter((clip) => clip.startFrame === 200);
    expect(new Set(lefts.map((clip) => clip.linkGroup)).size).toBe(1);
    expect(new Set(rights.map((clip) => clip.linkGroup)).size).toBe(1);
    expect(lefts[0].linkGroup).not.toBe(rights[0].linkGroup);
  });

  it('gives copies links of their own, not a weld to the originals', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.video]);
    store.duplicateClips(useProjectStore.getState().ui.selectedClipIds);

    const copies = useProjectStore.getState().ui.selectedClipIds.map(clipOf);
    expect(copies).toHaveLength(2);
    expect(copies[0].linkGroup).toBe(copies[1].linkGroup);
    expect(copies[0].linkGroup).not.toBe(clipOf(ids.video).linkGroup);
  });

  it('forgets a link whose other half was deleted', () => {
    const store = useProjectStore.getState();
    store.selectClips([ids.title], false, true);
    store.removeClips([ids.title]);
    expect(clipOf(ids.video).linkGroup).toBeUndefined();
  });
});

describe('a project saved with a link that lost its partner', () => {
  it('opens with the clip standing alone', () => {
    const ids = setUp();
    const store = useProjectStore.getState();
    store.selectClips([ids.video, ids.title]);
    store.linkSelection();

    const project = useProjectStore.getState().project;
    const { [ids.title]: _gone, ...clips } = project.clips;
    const opened = normalizeProject({ ...project, clips });
    expect(opened.clips[ids.video].linkGroup).toBeUndefined();
  });
});
