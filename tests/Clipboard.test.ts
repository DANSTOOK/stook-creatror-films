import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, MediaAsset } from '@shared/types';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Point 10: Ctrl+C, Ctrl+X and Ctrl+V for clips.
 */

const state = () => useProjectStore.getState();
const clipAt = (trackId: string, name: string, startFrame: number, durationFrames: number): Clip =>
  createClip({ trackId, name, sourceUri: `media://${name}`, startFrame, durationFrames });
const byName = () => {
  const groups: Record<string, Clip[]> = {};
  for (const clip of Object.values(state().project.clips)) (groups[clip.name] ??= []).push(clip);
  for (const list of Object.values(groups)) list.sort((a, b) => a.startFrame - b.startFrame);
  return groups;
};

let v1 = '';
let v2 = '';
let a1 = '';
const seed = (...clips: Clip[]) =>
  state().transact('seed', (project) => ({ ...project, clips: Object.fromEntries(clips.map((c) => [c.id, c])) }));

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
  useProjectStore.setState({ clipboard: null });
  const rows = timelineRows(state().project.tracks);
  [v2, v1, a1] = rows.map((track) => track.id);
});

describe('copy and paste', () => {
  it('pastes a copy at the playhead, on the same track, and selects it', () => {
    const a = clipAt(v1, 'a', 0, 60);
    seed(a);
    state().selectClips([a.id]);
    state().copySelection();
    state().setCurrentFrame(100);
    state().paste();

    const copies = byName().a;
    expect(copies.map((c) => [c.trackId, c.startFrame])).toEqual([[v1, 0], [v1, 100]]);
    expect(copies[1].id).not.toBe(a.id);
    expect(state().ui.selectedClipIds).toEqual([copies[1].id]);
  });

  it('moves the playhead past the paste, so pasting again lays the next copy after it', () => {
    const a = clipAt(v1, 'a', 0, 60);
    seed(a);
    state().selectClips([a.id]);
    state().copySelection();
    state().setCurrentFrame(60);
    state().paste();
    state().paste();
    expect(byName().a.map((c) => c.startFrame)).toEqual([0, 60, 120]);
    expect(state().project.currentFrame).toBe(180);
  });

  it('keeps the timing and the tracks between several copied clips', () => {
    const pic = clipAt(v1, 'pic', 0, 60);
    const title = clipAt(v2, 'title', 20, 30);
    const music = clipAt(a1, 'music', 10, 90);
    seed(pic, title, music);
    state().selectClips([pic.id, title.id, music.id]);
    state().copySelection();
    state().setCurrentFrame(300);
    state().paste();

    const all = byName();
    expect(all.pic[1]).toMatchObject({ trackId: v1, startFrame: 300 });
    expect(all.title[1]).toMatchObject({ trackId: v2, startFrame: 320 });
    expect(all.music[1]).toMatchObject({ trackId: a1, startFrame: 310 });
  });

  it('inserts: pasting over clips moves them along instead of covering them', () => {
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 60, 60);
    seed(a, b);
    state().selectClips([a.id]);
    state().copySelection();
    state().setCurrentFrame(60);
    state().paste();
    expect(byName().b[0].startFrame).toBe(120);
  });

  it('is a snapshot: editing the original afterwards does not change the paste', () => {
    const a = clipAt(v1, 'a', 0, 60);
    seed(a);
    state().selectClips([a.id]);
    state().copySelection();
    state().updateClip(a.id, { mask: { ...a.mask, feather: 99 } });
    state().setCurrentFrame(100);
    state().paste();
    const pasted = byName().a[1];
    expect(pasted.mask.feather).toBe(a.mask.feather);
  });

  it('pastes on another track of the right kind when the original one is gone', () => {
    const music: MediaAsset = {
      id: 'm', name: 'm', uri: 'media://music', kind: 'audio', durationFrames: 90, width: 0, height: 0, hasAlphaChannel: false,
    };
    state().addAssets([music]);
    state().addTrack('audio');
    const a2 = timelineRows(state().project.tracks).at(-1)!.id;
    const clip = clipAt(a2, 'music', 0, 90);
    seed(clip);
    state().selectClips([clip.id]);
    state().copySelection();
    state().removeTrack(a2);
    state().paste();
    expect(byName().music[0].trackId).toBe(a1);
  });

  it('is one undo step', () => {
    const a = clipAt(v1, 'a', 0, 60);
    seed(a);
    state().selectClips([a.id]);
    state().copySelection();
    state().setCurrentFrame(100);
    state().paste();
    state().undo();
    expect(byName().a).toHaveLength(1);
  });

  it('does nothing with an empty clipboard or an empty selection', () => {
    seed(clipAt(v1, 'a', 0, 60));
    state().copySelection();
    expect(state().clipboard).toBeNull();
    state().paste();
    expect(byName().a).toHaveLength(1);
  });
});

describe('cut', () => {
  it('removes the clips, closes the gap (magnet) and keeps them to paste', () => {
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 60, 60);
    seed(a, b);
    state().selectClips([a.id]);
    state().cutSelection();
    expect(byName().a).toBeUndefined();
    expect(byName().b[0].startFrame).toBe(0);

    state().setCurrentFrame(60);
    state().paste();
    expect(byName().a[0].startFrame).toBe(60);
  });
});
