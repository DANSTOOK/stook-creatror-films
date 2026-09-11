import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { clipsInMarquee, groupMoveStarts } from '@renderer/components/Timeline/marquee';
import { clipsInPaintOrder } from '@renderer/components/Timeline/timelineOps';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Selecting several clips with the mouse, moving them together, and picking
 * the right clip when two overlap.
 */

const state = () => useProjectStore.getState();

/** Video 1, Video 2, Audio 1 - with clips at known places. */
function layout(): { project: ProjectState; ids: Record<string, string> } {
  const base = createEmptyProject();
  const [v1, v2, a1] = base.tracks.map((track) => track.id);
  const make = (trackId: string, startFrame: number, durationFrames: number) =>
    createClip({ trackId, name: 'c', sourceUri: 'blob:c', startFrame, durationFrames });

  const clips = {
    a: make(v1, 0, 100), //    V1:  0-100
    b: make(v1, 200, 100), //  V1:  200-300
    c: make(v2, 50, 100), //   V2:  50-150
    d: make(a1, 400, 100), //  A1:  400-500
  };
  return {
    project: { ...base, clips: Object.fromEntries(Object.values(clips).map((clip) => [clip.id, clip])) },
    ids: Object.fromEntries(Object.entries(clips).map(([key, clip]) => [key, clip.id])),
  };
}

describe('clipsInMarquee', () => {
  it('selects every clip the band touches, not only the ones it swallows', () => {
    const { project, ids } = layout();
    const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
    // Frames 80-220 across both video rows: touches a (ends at 100), b (starts
    // at 200) and c, although it contains none of them whole.
    const picked = clipsInMarquee(project, tracks, { frameA: 80, frameB: 220, rowA: 0, rowB: 1 });
    expect(new Set(picked)).toEqual(new Set([ids.a, ids.b, ids.c]));
  });

  it('works whichever way the band is dragged', () => {
    const { project } = layout();
    const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
    const forwards = clipsInMarquee(project, tracks, { frameA: 80, frameB: 220, rowA: 0, rowB: 1 });
    const backwards = clipsInMarquee(project, tracks, { frameA: 220, frameB: 80, rowA: 1, rowB: 0 });
    expect(backwards).toEqual(forwards);
  });

  it('only takes clips on the rows it covers', () => {
    const { project, ids } = layout();
    const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
    expect(clipsInMarquee(project, tracks, { frameA: 0, frameB: 1000, rowA: 2, rowB: 2 })).toEqual([ids.d]);
  });

  it('leaves locked tracks out', () => {
    const { project, ids } = layout();
    const locked = {
      ...project,
      tracks: project.tracks.map((track, index) => (index === 0 ? { ...track, locked: true } : track)),
    };
    const tracks = [...locked.tracks].sort((a, b) => a.order - b.order);
    expect(clipsInMarquee(locked, tracks, { frameA: 0, frameB: 1000, rowA: 0, rowB: 1 })).toEqual([ids.c]);
  });
});

describe('groupMoveStarts', () => {
  const origins = new Map([['a', 100], ['b', 250], ['c', 400]]);

  it('moves every clip by the same amount, keeping the spacing', () => {
    expect([...groupMoveStarts(origins, 30).values()]).toEqual([130, 280, 430]);
  });

  it('stops the whole group when its first clip reaches frame 0', () => {
    // Asked to move 500 left, but the earliest clip is only 100 from the start:
    // the group moves 100, and the spacing inside it is untouched.
    expect([...groupMoveStarts(origins, -500).values()]).toEqual([0, 150, 300]);
  });
});

describe('overlapping clips', () => {
  it('paints later clips on top, and the selection above everything', () => {
    const { project, ids } = layout();
    const v1 = project.tracks[0].id;
    const onTop = clipsInPaintOrder(project, v1).map((clip) => clip.id);
    expect(onTop.at(-1)).toBe(ids.b);

    const withSelection = clipsInPaintOrder(project, v1, [ids.a]).map((clip) => clip.id);
    expect(withSelection.at(-1)).toBe(ids.a);
  });

  it('gives a click the clip that is visibly on top', () => {
    // Two clips stacked on the same track: the pointer hit-tests the paint
    // order backwards, so the first hit is the top one - not the one behind,
    // which is all that could ever be selected before.
    const base = createEmptyProject();
    const v1 = base.tracks[0].id;
    const behind = createClip({ trackId: v1, name: 'behind', sourceUri: 'blob:x', startFrame: 0, durationFrames: 200 });
    const inFront = createClip({ trackId: v1, name: 'front', sourceUri: 'blob:y', startFrame: 50, durationFrames: 100 });
    const project = { ...base, clips: { [behind.id]: behind, [inFront.id]: inFront } };

    const topmostFirst = clipsInPaintOrder(project, v1).reverse();
    const hit = topmostFirst.find((clip) => 100 >= clip.startFrame && 100 <= clip.startFrame + clip.durationFrames);
    expect(hit?.id).toBe(inFront.id);
  });
});

describe('moving a group through the store', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject();
    useHistoryStore.getState().clear();
  });

  it('moves several clips at once and undoes the whole drag as one step', () => {
    const v1 = state().project.tracks[0].id;
    const a = state().addClip({ trackId: v1, name: 'a', sourceUri: 'blob:a', startFrame: 0, durationFrames: 30 });
    const b = state().addClip({ trackId: v1, name: 'b', sourceUri: 'blob:b', startFrame: 60, durationFrames: 30 });

    // Three pointer moves of one drag, all with the same merge key.
    for (const delta of [10, 20, 40]) {
      state().setClipStarts(groupMoveStarts(new Map([[a, 0], [b, 60]]), delta), 'move-group:a');
    }
    expect(state().project.clips[a].startFrame).toBe(40);
    expect(state().project.clips[b].startFrame).toBe(100);

    state().undo();
    expect(state().project.clips[a].startFrame).toBe(0);
    expect(state().project.clips[b].startFrame).toBe(60);
  });

  it('carries keyframes with the clip, since they live in timeline time', () => {
    const v1 = state().project.tracks[0].id;
    const a = state().addClip({ trackId: v1, name: 'a', sourceUri: 'blob:a', startFrame: 0, durationFrames: 30 });
    state().setNumberKeyframe(a, 'opacity', 10, 0.5);

    state().setClipStarts(new Map([[a, 100]]));
    expect(state().project.clips[a].transform.opacity[0].frame).toBe(110);
  });

  it('leaves clips on a locked track where they are', () => {
    const v1 = state().project.tracks[0].id;
    const a = state().addClip({ trackId: v1, name: 'a', sourceUri: 'blob:a', startFrame: 0, durationFrames: 30 });
    state().updateTrack(v1, { locked: true });

    state().setClipStarts(new Map([[a, 100]]));
    expect(state().project.clips[a].startFrame).toBe(0);
  });
});
