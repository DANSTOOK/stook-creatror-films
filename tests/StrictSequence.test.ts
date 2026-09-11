import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, MediaAsset } from '@shared/types';
import { Compositor } from '@renderer/engine/Compositor';
import { groupMoveCollides, insertIntoTrack, trimLimit } from '@renderer/components/Timeline/trackPacking';
import { planDrop } from '@renderer/components/Timeline/dropPlacement';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Point 8: clips on one track follow one another strictly. An image put
 * before a video never ends up stacked over it in the export.
 */

const state = () => useProjectStore.getState();
const asset = (kind: MediaAsset['kind'], uri: string, durationFrames = 90): MediaAsset => ({
  id: uri, name: uri, uri, kind, durationFrames, width: 640, height: 360, hasAlphaChannel: false,
});
const clipAt = (trackId: string, name: string, startFrame: number, durationFrames: number): Clip =>
  createClip({ trackId, name, sourceUri: `media://${name}`, startFrame, durationFrames });

/** No two clips on one track share a frame. */
function overlaps(clips: Record<string, Clip>): string[] {
  const list = Object.values(clips);
  const found: string[] = [];
  for (const a of list) {
    for (const b of list) {
      if (a.id < b.id && a.trackId === b.trackId && a.startFrame < b.startFrame + b.durationFrames && b.startFrame < a.startFrame + a.durationFrames) {
        found.push(`${a.name}/${b.name}`);
      }
    }
  }
  return found;
}

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
});

describe('insertIntoTrack', () => {
  const t = 'track';
  const video = clipAt(t, 'video', 100, 200); // 100-300
  const after = clipAt(t, 'after', 300, 50); // 300-350, right behind it
  const far = clipAt(t, 'far', 500, 50);

  it('inserts into a gap and pushes only what it would cover', () => {
    const { startFrame, shifts } = insertIntoTrack([video, after, far], 60, 90); // 60-150
    expect(startFrame).toBe(60);
    // The video moves to the image's end, and the clip right behind it follows.
    expect(Object.fromEntries(shifts)).toEqual({ [video.id]: 150, [after.id]: 350 });
    // The far clip still clears them, so it stays where it was.
    expect(shifts.has(far.id)).toBe(false);
  });

  it('landing on the first half of a clip goes before it', () => {
    expect(insertIntoTrack([video], 150, 30).startFrame).toBe(100);
  });

  it('landing on the second half of a clip goes after it', () => {
    const { startFrame, shifts } = insertIntoTrack([video, after], 250, 30);
    expect(startFrame).toBe(300);
    expect(shifts.get(after.id)).toBe(330);
  });

  it('leaves everything alone when there is room', () => {
    expect(insertIntoTrack([video, far], 350, 100).shifts.size).toBe(0);
  });
});

describe('an image placed before a video (the reported case)', () => {
  it('goes before it, and the video moves along instead of being covered', () => {
    const film = asset('video', 'media://film', 300);
    const still = asset('image', 'media://still', 150);
    state().addAssets([film, still]);
    const track = state().project.tracks.find((tr) => tr.type === 'video')!;

    state().placeAssets([film], [{ assetId: film.id, trackId: track.id, trackType: 'video', startFrame: 60, durationFrames: 300 }]);
    // Dropped 30 frames before the video, but it is 150 frames long.
    state().placeAssets([still], planDrop(state().project, [{ id: still.id, kind: 'image', durationFrames: 150 }], track.id, 30));

    const clips = state().project.clips;
    const byName = Object.fromEntries(Object.values(clips).map((c) => [c.name, c]));
    expect(byName['media://still'].startFrame).toBe(30);
    expect(byName['media://film'].startFrame).toBe(180);
    expect(overlaps(clips)).toEqual([]);

    // In the export, exactly one of them is drawn at any frame.
    const project = state().project;
    for (const frame of [30, 100, 179, 180, 300]) {
      expect(Compositor.visibleClips(project, frame)).toHaveLength(1);
    }
  });
});

describe('every edit keeps a track strictly sequential', () => {
  const seed = (...clips: Clip[]) =>
    state().transact('seed', (project) => ({ ...project, clips: Object.fromEntries(clips.map((c) => [c.id, c])) }));
  const videoTrack = () => state().project.tracks.find((tr) => tr.type === 'video')!.id;

  it('moving a clip onto another inserts it and pushes the other along', () => {
    const t = videoTrack();
    const a = clipAt(t, 'a', 0, 60);
    const b = clipAt(t, 'b', 100, 60);
    seed(a, b);
    state().moveClipTo(b.id, t, 10); // onto the first half of a
    const clips = state().project.clips;
    expect(clips[b.id].startFrame).toBe(0);
    expect(clips[a.id].startFrame).toBe(60);
    expect(overlaps(clips)).toEqual([]);
  });

  it('a clip pushed aside during a drag goes back once the drag moves on', () => {
    const t = videoTrack();
    const a = clipAt(t, 'a', 0, 60);
    const b = clipAt(t, 'b', 100, 60);
    seed(a, b);
    const base = state().project.clips;
    state().moveClipTo(b.id, t, 10, base); // pushes a
    state().moveClipTo(b.id, t, 200, base); // on past it
    expect(state().project.clips[a.id].startFrame).toBe(0);
    expect(state().project.clips[b.id].startFrame).toBe(200);
  });

  it('trimming stops at the neighbouring clip', () => {
    const t = videoTrack();
    const a = clipAt(t, 'a', 0, 60);
    const b = clipAt(t, 'b', 80, 60);
    seed(a, b);
    expect(trimLimit(state().project.clips, a, 'end')).toBe(80);
    expect(trimLimit(state().project.clips, b, 'start')).toBe(60);
  });

  it('duplicating pushes the next clip along instead of covering it', () => {
    const t = videoTrack();
    const a = clipAt(t, 'a', 0, 60);
    const b = clipAt(t, 'b', 60, 60);
    seed(a, b);
    state().duplicateClips([a.id]);
    const clips = state().project.clips;
    expect(clips[b.id].startFrame).toBe(120);
    expect(overlaps(clips)).toEqual([]);
  });

  it('a group move stops against a clip that is not moving', () => {
    const t = videoTrack();
    const a = clipAt(t, 'a', 0, 60);
    const b = clipAt(t, 'b', 60, 60);
    const c = clipAt(t, 'c', 200, 60);
    seed(a, b, c);
    const clips = state().project.clips;
    expect(groupMoveCollides(clips, new Map([[a.id, 150], [b.id, 210]]))).toBe(true);
    expect(groupMoveCollides(clips, new Map([[a.id, 260], [b.id, 320]]))).toBe(false);

    state().setClipStarts(new Map([[a.id, 150], [b.id, 210]]));
    expect(state().project.clips[a.id].startFrame).toBe(0);
  });
});
