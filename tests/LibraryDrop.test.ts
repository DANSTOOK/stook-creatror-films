import { describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import { createTransition, cutNear, cutsOf } from '@renderer/timing/transitions';
import { titleDropPlacement } from '@renderer/text/titleClip';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { libraryDragKind, TITLE_DRAG_TYPE, TRANSITION_DRAG_TYPE } from '@renderer/components/MediaLibrary/libraryDrag';

/**
 * Where a title or transition dragged from the library lands. The drag
 * itself, in the running app, is tests/ui/transitions-f4.mjs.
 */

const base = createEmptyProject(1920, 1080, 30);
const v1 = base.tracks.find((track) => track.type === 'video' && track.order === 0)!;
const audio = base.tracks.find((track) => track.type === 'audio')!;
const clip = (id: string, trackId: string, startFrame: number, durationFrames: number): Clip => ({
  ...createClip({ trackId, name: id, sourceUri: `media://${id}`, startFrame, durationFrames }),
  id,
});
const project = (clips: Clip[], extra: Partial<ProjectState> = {}): ProjectState => ({
  ...base,
  clips: Object.fromEntries(clips.map((one) => [one.id, one])),
  ...extra,
});

describe('cuts a transition can be dropped on', () => {
  const a = clip('a', v1.id, 0, 90);
  const b = clip('b', v1.id, 90, 90);
  const c = clip('c', v1.id, 200, 60);
  const music1 = clip('m1', audio.id, 0, 90);
  const music2 = clip('m2', audio.id, 90, 90);

  it('are where two clips touch on a picture track, never on a sound track or across a gap', () => {
    const cuts = cutsOf(project([a, b, c, music1, music2]));
    expect(cuts).toEqual([{ fromId: 'a', toId: 'b', trackId: v1.id, frame: 90, transitionId: null }]);
  });

  it('say which transition is already on them', () => {
    const dissolve = createTransition(a, b, 'crossDissolve', 30, 'center');
    expect(cutsOf(project([a, b], { transitions: { [dissolve.id]: dissolve } }))[0].transitionId).toBe(dissolve.id);
  });

  it('the nearest one on the track under the pointer, while over one of its two clips', () => {
    const d = clip('d', v1.id, 180, 20);
    const p = project([a, b, d, c]);
    const cuts = cutsOf(p);
    expect(cutNear(p, cuts, v1.id, 100)?.frame).toBe(90);
    expect(cutNear(p, cuts, v1.id, 150)?.frame).toBe(180);
    expect(cutNear(p, cuts, v1.id, 30)?.frame).toBe(90);
    // Over the empty track, or past the last clip of a cut: nothing.
    expect(cutNear(p, cuts, 'elsewhere', 90)).toBeNull();
    expect(cutNear(p, cuts, v1.id, 300)).toBeNull();
  });
});

describe('where a dropped title goes', () => {
  const v2 = base.tracks.find((track) => track.type === 'video' && track.order === 1)!;

  it('on the track and frame it was dropped on, when free there', () => {
    const p = project([clip('a', v1.id, 0, 300)]);
    const placement = titleDropPlacement(p, v2.id, 40, 150);
    expect(placement).toEqual({ trackId: v2.id, startFrame: 40, durationFrames: 150 });
  });

  it('above, like Add title, when that track is taken there, is not a picture track, or is locked', () => {
    const p = project([clip('a', v1.id, 0, 300)]);
    expect(titleDropPlacement(p, v1.id, 40, 150).trackId).not.toBe(v1.id);
    expect(titleDropPlacement(p, audio.id, 40, 150).trackId).not.toBe(audio.id);
    const locked = { ...p, tracks: p.tracks.map((track) => (track.id === v2.id ? { ...track, locked: true } : track)) };
    expect(titleDropPlacement(locked, v2.id, 40, 150).trackId).not.toBe(v2.id);
  });
});

describe('library drags', () => {
  it('are told apart by their types, which can be read before the drop', () => {
    expect(libraryDragKind([TITLE_DRAG_TYPE])).toBe('title');
    expect(libraryDragKind(['text/plain', TRANSITION_DRAG_TYPE])).toBe('transition');
    expect(libraryDragKind(['Files'])).toBeNull();
  });
});
