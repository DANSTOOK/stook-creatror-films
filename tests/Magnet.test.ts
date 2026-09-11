import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import { closeGap, rippleDelete } from '@renderer/components/Timeline/trackPacking';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Point 9: the magnet. Deleting, moving or trimming a clip closes the hole it
 * leaves - and only that hole.
 */

const state = () => useProjectStore.getState();
const clipAt = (trackId: string, name: string, startFrame: number, durationFrames: number): Clip =>
  createClip({ trackId, name, sourceUri: `media://${name}`, startFrame, durationFrames });
const starts = () =>
  Object.fromEntries(Object.values(state().project.clips).map((clip) => [clip.name, clip.startFrame]));

let v1 = '';
let v2 = '';
const seed = (...clips: Clip[]) =>
  state().transact('seed', (project) => ({ ...project, clips: Object.fromEntries(clips.map((c) => [c.id, c])) }));

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
  const rows = timelineRows(state().project.tracks);
  v2 = rows[0].id;
  v1 = rows[1].id;
});

describe('closeGap / rippleDelete', () => {
  it('moves only what is after the hole, by exactly its length', () => {
    const a = clipAt('t', 'a', 0, 50);
    const b = clipAt('t', 'b', 80, 50);
    const shifts = closeGap({ [a.id]: a, [b.id]: b }, 't', 60, 20);
    expect(Object.fromEntries(shifts)).toEqual({ [b.id]: 60 });
  });

  it('closes several holes on one track without disturbing each other', () => {
    const a = clipAt('t', 'a', 0, 10);
    const b = clipAt('t', 'b', 10, 10);
    const c = clipAt('t', 'c', 20, 10);
    const d = clipAt('t', 'd', 30, 10);
    const moved = rippleDelete({ [a.id]: a, [b.id]: b, [c.id]: c, [d.id]: d }, new Set([a.id, c.id]));
    expect(moved.get(b.id)).toBe(0);
    expect(moved.get(d.id)).toBe(10);
  });
});

describe('with the magnet on (the default)', () => {
  it('is on by default', () => {
    expect(state().ui.rippleEnabled).toBe(true);
  });

  it('deleting a clip pulls what came after it into its place', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60), clipAt(v1, 'c', 120, 60));
    const b = Object.values(state().project.clips).find((c) => c.name === 'b')!;
    state().removeClips([b.id]);
    expect(starts()).toEqual({ a: 0, c: 60 });
  });

  it('keeps a gap that was left on purpose', () => {
    // a, a 30-frame pause, b, c.
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 90, 60), clipAt(v1, 'c', 150, 60));
    const b = Object.values(state().project.clips).find((c) => c.name === 'b')!;
    state().removeClips([b.id]);
    expect(starts()).toEqual({ a: 0, c: 90 });
  });

  it('leaves the other tracks alone', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60), clipAt(v2, 'title', 90, 30));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    state().removeClips([a.id]);
    expect(starts()).toEqual({ b: 0, title: 90 });
  });

  it('moving a clip to another track closes the hole it left', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60), clipAt(v1, 'c', 120, 60));
    const b = Object.values(state().project.clips).find((c) => c.name === 'b')!;
    state().moveClipTo(b.id, v2, 300);
    expect(starts()).toEqual({ a: 0, b: 300, c: 60 });
  });

  it('dragging a clip along its own track reorders it without leaving gaps', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60), clipAt(v1, 'c', 120, 60));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    const base = state().project.clips;
    // Drop a onto the second half of c: b and c close up, a goes after c.
    state().moveClipTo(a.id, v1, 100, base);
    expect(starts()).toEqual({ b: 0, c: 60, a: 120 });
  });

  it('trimming the end carries the rest of the track, both ways, gaps included', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 80, 60));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    state().trimClip(a.id, 'end', 40);
    expect(starts()).toEqual({ a: 0, b: 60 });
    state().trimClip(a.id, 'end', 50);
    expect(starts()).toEqual({ a: 0, b: 70 });
  });

  it('is one undo step', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    state().removeClips([a.id]);
    state().undo();
    expect(starts()).toEqual({ a: 0, b: 60 });
  });
});

describe('with the magnet off', () => {
  beforeEach(() => state().setUi({ rippleEnabled: false }));

  it('deleting leaves the hole', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 60, 60));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    state().removeClips([a.id]);
    expect(starts()).toEqual({ b: 60 });
  });

  it('trimming the end stops at the next clip instead of pushing it', () => {
    seed(clipAt(v1, 'a', 0, 60), clipAt(v1, 'b', 80, 60));
    const a = Object.values(state().project.clips).find((c) => c.name === 'a')!;
    state().trimClip(a.id, 'end', 200);
    expect(state().project.clips[a.id].durationFrames).toBeLessThanOrEqual(80);
    expect(starts()).toEqual({ a: 0, b: 80 });
  });
});
