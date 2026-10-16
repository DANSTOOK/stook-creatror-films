import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, MediaAsset, ProjectState } from '@shared/types';
import {
  groupSelection,
  sameLook,
  sameNumber,
  shared,
  staticOpacity,
  withBlend,
  withLut,
  withLutIntensity,
  withOpacity,
  withoutLut,
} from '@renderer/components/Inspector/multiSelection';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The inspector with several clips selected: which clips a setting reaches,
 * when a value reads as mixed, and - the part a user feels - that one change
 * to the whole selection is one Ctrl+Z, a slider drag included.
 */

const state = () => useProjectStore.getState();
const history = () => useHistoryStore.getState();

/* The rules ---------------------------------------------------------------- */

describe('a value over several clips', () => {
  it('is the value when they all agree', () => {
    expect(shared([0.5, 0.5, 0.5], 1)).toEqual({ mixed: false, value: 0.5 });
    expect(shared(['multiply', 'multiply'], 'normal')).toEqual({ mixed: false, value: 'multiply' });
  });

  it('is mixed when any one differs, rather than the first clip\'s value', () => {
    expect(shared([0.5, 0.5, 0.25], 1)).toEqual({ mixed: true });
    expect(shared(['normal', 'screen'], 'normal')).toEqual({ mixed: true });
  });

  it('takes a slider\'s last-bit noise as the same number', () => {
    expect(shared([0.3, 0.1 + 0.2], 1, sameNumber)).toEqual({ mixed: false, value: 0.3 });
    expect(shared([0.3, 0.31], 1, sameNumber)).toEqual({ mixed: true });
  });
});

describe('which clips a setting reaches', () => {
  const project = createEmptyProject();
  const [v1, , a1] = project.tracks.map((track) => track.id);
  const clip = (trackId: string, uri: string, extra: Partial<Clip> = {}): Clip => ({
    ...createClip({ trackId, name: uri, sourceUri: uri, startFrame: 0, durationFrames: 10 }),
    ...extra,
  });
  const asset = (uri: string, kind: MediaAsset['kind']): MediaAsset => ({
    id: uri, name: uri, uri, kind, durationFrames: 10, width: 64, height: 64, hasAlphaChannel: false,
  });
  const video = clip(v1, 'video.mp4');
  const still = clip(v1, 'still.png');
  const sound = clip(a1, 'sound.wav');
  const title = clip(v1, 'title', { title: {} as Clip['title'] });
  const caption = clip(v1, 'caption', { caption: {} as Clip['caption'] });
  const all = [video, still, sound, title, caption];
  const withClips: ProjectState = { ...project, clips: Object.fromEntries(all.map((entry) => [entry.id, entry])) };
  const assets = [asset('video.mp4', 'video'), asset('still.png', 'image'), asset('sound.wav', 'audio')];
  const groups = groupSelection([...all.map((entry) => entry.id), 'gone'], withClips, assets);
  const names = (clips: Clip[]) => clips.map((entry) => entry.name);

  it('counts only clips that still exist', () => {
    expect(groups.all).toHaveLength(5);
  });

  it('composites every picture, a title\'s included, and no sound or caption', () => {
    expect(names(groups.visual)).toEqual(['video.mp4', 'still.png', 'title']);
  });

  it('grades footage and stills, not titles', () => {
    expect(names(groups.gradeable)).toEqual(['video.mp4', 'still.png']);
  });

  it('sets the volume of what has a sound', () => {
    expect(names(groups.audible)).toEqual(['video.mp4', 'sound.wav']);
  });
});

describe('the edits', () => {
  const base = createClip({ trackId: 't', name: 'c', sourceUri: 'u', startFrame: 30, durationFrames: 10 });

  it('gives a clip without keyframes one opacity throughout', () => {
    const patch = withOpacity(base, 0.4);
    expect(patch?.transform?.opacity).toEqual([expect.objectContaining({ frame: 30, value: 0.4 })]);
    expect(staticOpacity({ ...base, ...patch })).toBe(0.4);
    expect(staticOpacity(base)).toBe(1);
  });

  it('leaves an animated opacity alone instead of flattening the fade', () => {
    const fade: Clip = {
      ...base,
      transform: {
        ...base.transform,
        opacity: [
          { id: 'a', frame: 30, value: 0, easing: 'linear' },
          { id: 'b', frame: 39, value: 1, easing: 'linear' },
        ],
      },
    };
    expect(staticOpacity(fade)).toBeNull();
    expect(withOpacity(fade, 0.5)).toBeNull();
  });

  it('stores normal as no blend mode', () => {
    expect(withBlend('normal')).toEqual({ blendMode: undefined });
    expect(withBlend('screen')).toEqual({ blendMode: 'screen' });
  });

  it('replaces the path with the look, so an old path cannot bring the old look back', () => {
    const graded = { ...base, ...withLut(base, { uri: 'blob:a', name: 'a.cube', sourcePath: 'C:/a.cube' }) };
    expect(graded.colorGrading).toMatchObject({ enabled: true, lutUri: 'blob:a', lutSourcePath: 'C:/a.cube' });
    const dropped = { ...graded, ...withLut(graded, { uri: 'blob:b', name: 'b.cube' }) };
    expect(dropped.colorGrading.lutSourcePath).toBeUndefined();
    expect(withoutLut(base)).toBeNull();
    expect(withoutLut(graded)?.colorGrading).toMatchObject({ lutUri: undefined, lutSourcePath: undefined });
    // An intensity means nothing on a clip with no look.
    expect(withLutIntensity(base, 0.5)).toBeNull();
    expect(withLutIntensity(graded, 0.5)?.colorGrading?.lutIntensity).toBe(0.5);
  });

  it('calls two loads of one file the same look', () => {
    const one = { ...base, ...withLut(base, { uri: 'blob:1', name: 'x', sourcePath: 'C:/x.cube' }) };
    const two = { ...base, ...withLut(base, { uri: 'blob:2', name: 'x', sourcePath: 'C:/x.cube' }) };
    const other = { ...base, ...withLut(base, { uri: 'blob:3', name: 'y', sourcePath: 'C:/y.cube' }) };
    expect(sameLook(one, two)).toBe(true);
    expect(sameLook(one, other)).toBe(false);
    expect(sameLook(one, base)).toBe(false);
    expect(sameLook(base, base)).toBe(true);
  });
});

/* One gesture, one undo step ------------------------------------------------ */

describe('updateClips', () => {
  let ids: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
    state().newProject();
    const v1 = state().project.tracks.find((track) => track.type === 'video')!.id;
    ids = [0, 100, 200].map((startFrame) =>
      state().addClip({ trackId: v1, name: `c${startFrame}`, sourceUri: 'blob:c', startFrame, durationFrames: 100 }),
    );
    history().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const clips = () => ids.map((id) => state().project.clips[id]);

  it('changes every clip as one undo step', () => {
    state().updateClips(ids, () => withBlend('multiply'));
    expect(clips().map((clip) => clip.blendMode)).toEqual(['multiply', 'multiply', 'multiply']);
    expect(history().undoStack).toHaveLength(1);

    state().undo();
    expect(clips().map((clip) => clip.blendMode)).toEqual([undefined, undefined, undefined]);
    state().redo();
    expect(clips().map((clip) => clip.blendMode)).toEqual(['multiply', 'multiply', 'multiply']);
  });

  it('keeps a slider dragged across the selection to one step', () => {
    // A drag: an input event every 16 ms, 30 of them.
    for (let step = 1; step <= 30; step += 1) {
      state().updateClips(ids, (clip) => withOpacity(clip, 1 - step / 60), 'multi:opacity:sel');
      vi.advanceTimersByTime(16);
    }
    expect(clips().map(staticOpacity)).toEqual([0.5, 0.5, 0.5]);
    expect(history().undoStack).toHaveLength(1);

    state().undo();
    // Back to before the drag began, on all three - not to its second-last step.
    expect(clips().map((clip) => clip.transform.opacity)).toEqual([[], [], []]);
    expect(history().canUndo).toBe(false);
  });

  it('keeps two separate drags as two steps', () => {
    state().updateClips(ids, (clip) => withOpacity(clip, 0.8), 'multi:opacity:sel');
    vi.advanceTimersByTime(2000);
    state().updateClips(ids, (clip) => withOpacity(clip, 0.3), 'multi:opacity:sel');
    expect(history().undoStack).toHaveLength(2);
    state().undo();
    expect(clips().map(staticOpacity)).toEqual([0.8, 0.8, 0.8]);
  });

  it('records nothing when no clip changes', () => {
    state().updateClips(ids, () => null);
    state().updateClips(['gone'], () => withBlend('screen'));
    expect(history().undoStack).toHaveLength(0);
  });

  it('touches only the clips asked for', () => {
    state().updateClips(ids.slice(0, 2), () => ({ volume: 0.5 }));
    expect(clips().map((clip) => clip.volume)).toEqual([0.5, 0.5, 1]);
  });
});
