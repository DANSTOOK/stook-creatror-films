import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, MediaAsset } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Moving several selected clips together - by mouse and by arrow keys.
 *
 * A group used to be refused whole the moment any clip in it touched one that
 * was not selected, and with the magnet on clips always touch: selecting two
 * clips and dragging did nothing at all. The arrows only ever moved the
 * playhead. A group now moves by the rules one clip does, and the arrows move
 * the selection.
 */

const state = () => useProjectStore.getState();

const clipAt = (trackId: string, name: string, startFrame: number, durationFrames: number, kind = 'video'): Clip =>
  createClip({ trackId, name, sourceUri: `media://${kind}/${name}`, startFrame, durationFrames });

const asset = (uri: string, kind: MediaAsset['kind']): MediaAsset => ({
  id: uri, name: uri, uri, kind, durationFrames: 600, width: 640, height: 360, hasAlphaChannel: false,
});

function seed(...clips: Clip[]): void {
  state().transact('seed', (project) => ({ ...project, clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])) }));
  useProjectStore.setState({
    assets: clips.map((clip) => asset(clip.sourceUri, clip.sourceUri.includes('/audio/') ? 'audio' : 'video')),
  });
  useHistoryStore.getState().clear();
}

const track = (name: string) => state().project.tracks.find((candidate) => candidate.name === name)!.id;
const start = (clip: Clip) => state().project.clips[clip.id].startFrame;
const trackOf = (clip: Clip) => state().project.clips[clip.id].trackId;
const magnet = (on: boolean) => state().setUi({ rippleEnabled: on });

/** No two clips on one track share a frame. */
function overlaps(): string[] {
  const list = Object.values(state().project.clips);
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

describe('dragging a selection', () => {
  it('moves a group that touches other clips - it used to be frozen', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 60, 60);
    const c = clipAt(v1, 'c', 120, 60);
    seed(a, b, c);

    state().moveClipGroup([a.id, b.id], 10, 0);

    expect([start(a), start(b)]).toEqual([10, 70]);
    expect(start(c)).toBe(130); // moved along, not covered
    expect(overlaps()).toEqual([]);
  });

  it('with the magnet, reorders past a neighbour without leaving a hole', () => {
    magnet(true);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 60, 60);
    const c = clipAt(v1, 'c', 120, 60);
    seed(a, b, c);

    state().moveClipGroup([a.id, b.id], 60, 0);

    expect([start(c), start(a), start(b)]).toEqual([0, 60, 120]);
    expect(overlaps()).toEqual([]);
  });

  it('keeps a picture and its sound aligned when the group lands on an edge', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a1 = track('Audio 1');
    const other = clipAt(v1, 'other', 0, 100);
    const picture = clipAt(v1, 'picture', 200, 50);
    const sound = clipAt(a1, 'sound', 200, 50, 'audio');
    seed(other, picture, sound);

    // Dropped into the second half of "other": the picture goes after it, and
    // the sound, with nothing in its way, follows it exactly.
    state().moveClipGroup([picture.id, sound.id], -130, 0, { anchorId: picture.id });

    expect(start(picture)).toBe(100);
    expect(start(sound)).toBe(100);
  });

  it('puts a clip it pushed aside back when the drag moves on', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 100, 60);
    const c = clipAt(v1, 'c', 160, 20);
    seed(a, b, c);
    const base = state().project.clips;

    state().moveClipGroup([b.id, c.id], -90, 0, { base, mergeKey: 'drag' });
    expect(start(a)).toBe(80);
    state().moveClipGroup([b.id, c.id], 100, 0, { base, mergeKey: 'drag' });

    expect(start(a)).toBe(0);
    expect([start(b), start(c)]).toEqual([200, 260]);
  });

  it('undoes a whole drag in one step', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 30);
    const b = clipAt(v1, 'b', 60, 30);
    seed(a, b);
    const base = state().project.clips;

    for (const delta of [10, 20, 40]) state().moveClipGroup([a.id, b.id], delta, 0, { base, mergeKey: 'move-group:a' });
    expect([start(a), start(b)]).toEqual([40, 100]);

    state().undo();
    expect([start(a), start(b)]).toEqual([0, 60]);
  });

  it('changes tracks only when every clip has a track that takes it', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a1 = track('Audio 1');
    const picture = clipAt(v1, 'picture', 0, 50);
    const sound = clipAt(a1, 'sound', 0, 50, 'audio');
    seed(picture, sound);

    // Rows top-down are Video 2, Video 1, Audio 1. Down would put the picture
    // on an audio track; up would put the sound on a video track.
    state().moveClipGroup([picture.id, sound.id], 0, 1);
    state().moveClipGroup([picture.id, sound.id], 0, -1);
    expect([trackOf(picture), trackOf(sound)]).toEqual([v1, a1]);

    state().moveClipGroup([picture.id], 0, -1);
    expect(trackOf(picture)).toBe(track('Video 2'));
  });

  it('leaves clips on a locked track where they are', () => {
    magnet(false);
    const v1 = track('Video 1');
    const v2 = track('Video 2');
    const a = clipAt(v1, 'a', 0, 30);
    const b = clipAt(v2, 'b', 0, 30);
    seed(a, b);
    state().updateTrack(v1, { locked: true });

    state().moveClipGroup([a.id, b.id], 25, 0);

    expect(start(a)).toBe(0);
    expect(start(b)).toBe(25);
  });
});

describe('undo and the selection', () => {
  it('keeps a moved group selected after undo, so it can be moved again', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 30);
    const b = clipAt(v1, 'b', 60, 30);
    seed(a, b);
    state().selectClips([a.id, b.id]);

    state().moveClipGroup([a.id, b.id], 40, 0);
    state().undo();

    expect([start(a), start(b)]).toEqual([0, 60]);
    expect(state().ui.selectedClipIds).toEqual([a.id, b.id]);

    state().redo();
    expect(state().ui.selectedClipIds).toEqual([a.id, b.id]);
  });

  it('drops from the selection only a clip the undone step takes away', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 30);
    seed(a);
    const added = clipAt(v1, 'added', 100, 30);
    state().transact('add', (project) => ({ ...project, clips: { ...project.clips, [added.id]: added } }));
    state().selectClips([a.id, added.id]);

    state().undo();

    expect(state().ui.selectedClipIds).toEqual([a.id]);
  });
});

describe('arrow keys', () => {
  it('move the selection a frame, or ten, through free space', () => {
    magnet(true);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 100, 60);
    seed(a);
    state().selectClips([a.id]);

    state().nudgeSelection(1, 0);
    expect(start(a)).toBe(101);
    state().nudgeSelection(-10, 0);
    expect(start(a)).toBe(91);
  });

  it('do not drag the rest of the track along with a one-frame nudge', () => {
    magnet(true);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 100, 60);
    seed(a, b);
    state().selectClips([a.id]);

    state().nudgeSelection(1, 0);

    expect(start(a)).toBe(1);
    expect(start(b)).toBe(100);
  });

  it('hop over a touching neighbour instead of doing nothing', () => {
    magnet(true);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    const b = clipAt(v1, 'b', 60, 60);
    seed(a, b);
    state().selectClips([a.id]);

    state().nudgeSelection(1, 0);
    expect([start(b), start(a)]).toEqual([0, 60]);

    state().nudgeSelection(-1, 0);
    expect([start(a), start(b)]).toEqual([0, 60]);
    expect(overlaps()).toEqual([]);
  });

  it('move a whole selection together', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a1 = track('Audio 1');
    const picture = clipAt(v1, 'picture', 30, 50);
    const sound = clipAt(a1, 'sound', 30, 50, 'audio');
    seed(picture, sound);
    state().selectClips([picture.id, sound.id]);

    state().nudgeSelection(10, 0);

    expect([start(picture), start(sound)]).toEqual([40, 40]);
  });

  it('move the selection up a track', () => {
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 0, 60);
    seed(a);
    state().selectClips([a.id]);

    state().nudgeSelection(0, -1);

    expect(trackOf(a)).toBe(track('Video 2'));
  });

  it('fold a held key into one undo step', () => {
    magnet(false);
    const v1 = track('Video 1');
    const a = clipAt(v1, 'a', 100, 60);
    seed(a);
    state().selectClips([a.id]);

    state().nudgeSelection(1, 0, false);
    state().nudgeSelection(1, 0, true);
    state().nudgeSelection(1, 0, true);
    expect(start(a)).toBe(103);

    state().undo();
    expect(start(a)).toBe(101);
    state().undo();
    expect(start(a)).toBe(100);
  });
});
