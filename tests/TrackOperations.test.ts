import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Track and clip management through the store.
 *
 * These go through the real store rather than pure helpers because the point of
 * the test is the whole transaction - including that every one of them lands in
 * the undo history, which is what makes deleting a track safe without a
 * confirmation prompt.
 */

const state = () => useProjectStore.getState();
const trackNames = (): string[] =>
  [...state().project.tracks].sort((a, b) => a.order - b.order).map((track) => track.name);

beforeEach(() => {
  useProjectStore.getState().newProject();
  useHistoryStore.getState().clear();
});

describe('track ordering', () => {
  it('starts with contiguous order values', () => {
    expect([...state().project.tracks].map((t) => t.order).sort()).toEqual([0, 1, 2]);
  });

  it('inserts a track above the given position', () => {
    const before = trackNames();
    state().addTrackAt('video', 1, 'Inserted');

    expect(trackNames()[1]).toBe('Inserted');
    expect(trackNames()).toHaveLength(before.length + 1);
  });

  it('inserts at the end when the position is past the last track', () => {
    state().addTrackAt('audio', 99, 'Last');
    expect(trackNames().at(-1)).toBe('Last');
  });

  it('keeps order values contiguous after an insert', () => {
    state().addTrackAt('video', 1, 'Inserted');
    const orders = [...state().project.tracks].map((t) => t.order).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1, 2, 3]);
  });

  it('moves a track down and back up again', () => {
    const original = trackNames();
    const first = state().project.tracks.find((t) => t.order === 0)!;

    state().moveTrack(first.id, 1);
    expect(trackNames()[1]).toBe(original[0]);

    state().moveTrack(first.id, -1);
    expect(trackNames()).toEqual(original);
  });

  it('refuses to move past either end', () => {
    const ordered = [...state().project.tracks].sort((a, b) => a.order - b.order);
    const before = trackNames();

    state().moveTrack(ordered[0].id, -1);
    state().moveTrack(ordered[ordered.length - 1].id, 1);

    expect(trackNames()).toEqual(before);
  });
});

describe('removeTrack', () => {
  it('deletes the track and every clip on it', () => {
    const track = state().project.tracks[0];
    const clip = createClip({
      trackId: track.id,
      name: 'doomed',
      sourceUri: 'blob:x',
      startFrame: 0,
      durationFrames: 30,
    });

    state().transact('seed', (project) => ({ ...project, clips: { [clip.id]: clip } }));
    expect(Object.keys(state().project.clips)).toHaveLength(1);

    state().removeTrack(track.id);

    expect(state().project.tracks.some((t) => t.id === track.id)).toBe(false);
    expect(Object.keys(state().project.clips)).toHaveLength(0);
  });

  it('leaves clips on other tracks alone', () => {
    const [first, second] = state().project.tracks;
    const keeper = createClip({
      trackId: second.id,
      name: 'keeper',
      sourceUri: 'blob:k',
      startFrame: 0,
      durationFrames: 30,
    });

    state().transact('seed', (project) => ({ ...project, clips: { [keeper.id]: keeper } }));
    state().removeTrack(first.id);

    expect(state().project.clips[keeper.id]).toBeDefined();
  });

  it('renumbers the survivors so no gap is left behind', () => {
    state().removeTrack(state().project.tracks[1].id);
    const orders = [...state().project.tracks].map((t) => t.order).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1]);
  });

  it('is undoable, which is why deleting needs no confirmation', () => {
    const before = trackNames();
    const track = state().project.tracks[0];

    state().removeTrack(track.id);
    expect(trackNames()).toHaveLength(before.length - 1);

    state().undo();
    expect(trackNames()).toEqual(before);
  });

  it('clears the selection, so nothing points at a deleted clip', () => {
    const track = state().project.tracks[0];
    const clip = createClip({
      trackId: track.id,
      name: 'doomed',
      sourceUri: 'blob:x',
      startFrame: 0,
      durationFrames: 30,
    });

    state().transact('seed', (project) => ({ ...project, clips: { [clip.id]: clip } }));
    state().selectClips([clip.id]);

    state().removeTrack(track.id);
    expect(state().ui.selectedClipIds).toEqual([]);
  });
});

describe('duplicateClips', () => {
  const seedClip = (startFrame = 100, durationFrames = 60) => {
    const track = state().project.tracks[0];
    const clip = createClip({
      trackId: track.id,
      name: 'source',
      sourceUri: 'blob:s',
      startFrame,
      durationFrames,
    });
    state().transact('seed', (project) => ({ ...project, clips: { [clip.id]: clip } }));
    return clip;
  };

  it('places the copy directly after the original', () => {
    const clip = seedClip(100, 60);
    state().duplicateClips([clip.id]);

    const copy = Object.values(state().project.clips).find((c) => c.id !== clip.id)!;
    expect(copy.startFrame).toBe(160);
    expect(copy.durationFrames).toBe(60);
  });

  it('gives the copy a new identity but the same source', () => {
    const clip = seedClip();
    state().duplicateClips([clip.id]);

    const copy = Object.values(state().project.clips).find((c) => c.id !== clip.id)!;
    expect(copy.id).not.toBe(clip.id);
    expect(copy.sourceUri).toBe(clip.sourceUri);
    expect(copy.sourceOffsetFrames).toBe(clip.sourceOffsetFrames);
  });

  it('deep-copies nested config so edits do not leak between copies', () => {
    const clip = seedClip();
    state().duplicateClips([clip.id]);

    const copy = Object.values(state().project.clips).find((c) => c.id !== clip.id)!;
    state().updateClip(copy.id, { mask: { ...copy.mask, feather: 99 } });

    expect(state().project.clips[clip.id].mask.feather).not.toBe(99);
  });

  it('selects the new copies', () => {
    const clip = seedClip();
    state().duplicateClips([clip.id]);

    const copy = Object.values(state().project.clips).find((c) => c.id !== clip.id)!;
    expect(state().ui.selectedClipIds).toEqual([copy.id]);
  });

  it('ignores ids that do not exist', () => {
    const clip = seedClip();
    state().duplicateClips([clip.id, 'nope']);
    expect(Object.keys(state().project.clips)).toHaveLength(2);
  });

  it('does nothing for an empty selection', () => {
    seedClip();
    const before = Object.keys(state().project.clips).length;
    state().duplicateClips([]);
    expect(Object.keys(state().project.clips)).toHaveLength(before);
  });
});
