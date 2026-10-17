import { beforeEach, describe, expect, it } from 'vitest';
import { BLEND_MODES, type BlendMode, type Clip } from '@shared/types';
import { clipLayer, coveringClip, coversFrame, frameToJudge, trackAboveFor } from '@renderer/components/Timeline/layers';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { Compositor } from '@renderer/engine/Compositor';
import { blendChannel, blendOver } from '@renderer/engine/blending';
import { createTransition } from '@renderer/timing/transitions';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { createClip } from '@renderer/store/types';

/**
 * "Text sometimes shows underneath, even on Video 1": a title on Video 1
 * under a video on Video 2 is drawn as every editor draws it - not at all.
 * Working as designed, and invisible as designed; what was missing is being
 * told. These pin what the inspector says and what "Move above" does.
 */

const state = () => useProjectStore.getState();
const track = (name: string) => state().project.tracks.find((candidate) => candidate.name === name)!;
const SIZE = { width: 1920, height: 1080 };

const picture = (trackId: string, overrides: Partial<Clip> = {}): Clip => ({
  ...createClip({ trackId, name: 'film.mp4', sourceUri: 'media://film', startFrame: 0, durationFrames: 300 }),
  ...overrides,
});

const add = (clip: Clip): string => {
  state().transact('seed', (project) => ({ ...project, clips: { ...project.clips, [clip.id]: clip } }));
  return clip.id;
};

const videoTracks = () => state().project.tracks.filter((candidate) => candidate.type === 'video');

beforeEach(() => {
  state().newProject(1920, 1080, 30);
  useHistoryStore.getState().clear();
});

describe('what covers the whole frame', () => {
  it('a plain picture at its place does', () => {
    expect(coversFrame(picture('t'), 10, SIZE)).toBe(true);
  });

  it('a picture scaled up past the frame still does, and so does one turned upside down', () => {
    const base = picture('t');
    const big = { ...base, transform: { ...base.transform, scale: [{ id: 'k', frame: 0, value: { x: 1.3, y: 1.3 }, easing: 'linear' as const }] } };
    expect(coversFrame(big, 10, SIZE)).toBe(true);
    const turned = { ...base, transform: { ...base.transform, rotation: [{ id: 'k', frame: 0, value: 180, easing: 'linear' as const }] } };
    expect(coversFrame(turned, 10, SIZE)).toBe(true);
  });

  it('text, transparency, a smaller picture, a fade, half opacity or a slight turn do not', () => {
    const base = picture('t');
    expect(coversFrame({ ...base, title: { preset: 'title', text: 'Hi', style: {} as never } } as Clip, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, hasAlphaChannel: true }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, transform: { ...base.transform, scale: [{ id: 'k', frame: 0, value: { x: 0.5, y: 0.5 }, easing: 'linear' }] } }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, transform: { ...base.transform, opacity: [{ id: 'k', frame: 0, value: 0.5, easing: 'linear' }] } }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, transform: { ...base.transform, rotation: [{ id: 'k', frame: 0, value: 10, easing: 'linear' }] } }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, fadeInFrames: 30 }, 10, SIZE)).toBe(false);
    expect(coversFrame(base, 300, SIZE)).toBe(false);
  });

  it('a key, a mask or Remove background lets the picture below through', () => {
    const base = picture('t');
    expect(coversFrame({ ...base, chromaKey: { ...base.chromaKey, enabled: true } }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, mask: { ...base.mask, enabled: true, type: 1 } }, 10, SIZE)).toBe(false);
    expect(coversFrame({ ...base, backgroundRemoval: { ...base.backgroundRemoval, enabled: true } }, 10, SIZE)).toBe(false);
    // A mask switched on with no shape is not drawn (Compositor applyEffectChain).
    expect(coversFrame({ ...base, mask: { ...base.mask, enabled: true, type: 0 } }, 10, SIZE)).toBe(true);
  });
});

/*
  Blend modes. With an opaque layer the compositor's W3C blend gives
  B(Cb, Cs): only for normal is that the layer's colour alone. These check the
  claim in Timeline/layers against the engine's own formulas, so a mode added
  later that does hide what is under it cannot slip past unnoticed.
*/
describe('blend modes: only normal hides what is under it', () => {
  const backdrops = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const neutral = (mode: BlendMode): number | undefined =>
    [0, 0.5, 1].find((cs) => backdrops.every((cb) => Math.abs(blendChannel(mode, cb, cs) - cb) < 1e-9));

  it('every mode but normal has a colour that lets the backdrop through untouched', () => {
    for (const mode of BLEND_MODES) {
      if (mode === 'normal') continue;
      expect(neutral(mode), mode).toBeDefined();
    }
  });

  it('normal never does: an opaque normal layer is its own colour over any backdrop', () => {
    expect(neutral('normal')).toBeUndefined();
    const over = blendOver({ r: 0.2, g: 0.4, b: 0.6, a: 1 }, { r: 0.9, g: 0.1, b: 0.3, a: 1 }, 'normal');
    expect([over.r, over.g, over.b]).toEqual([0.9, 0.1, 0.3]);
  });

  it('so a full-frame picture in any other mode is not counted as hiding anything', () => {
    for (const mode of BLEND_MODES) {
      expect(coversFrame(picture('t', { blendMode: mode }), 10, SIZE), mode).toBe(mode === 'normal');
    }
  });

  it('a screen layer above a title does not hide it; a normal one above both does', () => {
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 0 });
    add(picture(track('Video 2').id, { name: 'glow.mp4', blendMode: 'screen' }));
    expect(coveringClip(state().project, title, 30)).toBeNull();

    state().addTrack('video');
    add(picture(track('Video 3').id, { name: 'solid.mp4' }));
    // Once a layer has replaced the picture, nothing above brings it back:
    // the screen layer between them changes nothing.
    expect(coveringClip(state().project, title, 30)?.clip.name).toBe('solid.mp4');
  });

  it("the hidden clip's own mode does not matter", () => {
    const low = add(picture(track('Video 1').id, { name: 'low', blendMode: 'multiply' }));
    add(picture(track('Video 2').id, { name: 'cover' }));
    expect(coveringClip(state().project, low, 30)?.clip.name).toBe('cover');
  });
});

describe('transitions', () => {
  it('a picture in a transition at that frame is not counted as hiding anything', () => {
    const low = add(picture(track('Video 1').id, { name: 'low', durationFrames: 600 }));
    const a = picture(track('Video 2').id, { name: 'a', startFrame: 0, durationFrames: 150 });
    const b = picture(track('Video 2').id, { name: 'b', startFrame: 150, durationFrames: 150 });
    add(a);
    add(b);
    const wipe = createTransition(a, b, 'wipe', 30, 'center');
    state().transact('seed', (project) => ({ ...project, transitions: { ...project.transitions, [wipe.id]: wipe } }));
    expect(Object.keys(state().project.transitions ?? {})).toHaveLength(1);
    // In the wipe, half of the frame is open; outside it, b covers the frame.
    expect(coveringClip(state().project, low, 150)).toBeNull();
    expect(coveringClip(state().project, low, 200)?.clip.name).toBe('b');
  });
});

describe('the layer a clip is on', () => {
  it('Video 1 is the bottom layer, under Video 2', () => {
    const id = add(picture(track('Video 1').id));
    const layer = clipLayer(state().project, id)!;
    expect(layer.layer).toBe(1);
    expect(layer.layers).toBe(2);
    expect(layer.above?.name).toBe('Video 2');
    expect(layer.below).toBeNull();
  });

  it('a clip on a sound track has no layer', () => {
    const id = add(picture(track('Audio 1').id));
    expect(clipLayer(state().project, id)).toBeNull();
  });

  it('is judged at the playhead when it is over the clip, otherwise at its first frame', () => {
    const clip = picture('t', { startFrame: 100, durationFrames: 50 });
    expect(frameToJudge(clip, 120)).toBe(120);
    expect(frameToJudge(clip, 10)).toBe(100);
    expect(frameToJudge(clip, 150)).toBe(100);
  });
});

describe('a title on Video 1 under a video on Video 2', () => {
  it('is hidden, and the inspector can say by what', () => {
    add(picture(track('Video 2').id, { name: 'interview.mp4' }));
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 30 });
    expect(state().project.clips[title].trackId).toBe(track('Video 1').id);

    const cover = coveringClip(state().project, title, 60);
    expect(cover?.clip.name).toBe('interview.mp4');
    expect(cover?.track.name).toBe('Video 2');
    // And the compositor does draw it first, under the video.
    expect(Compositor.visibleClips(state().project, 60).map((clip) => clip.id)[0]).toBe(title);
  });

  it('is not hidden when the track above is switched off', () => {
    add(picture(track('Video 2').id));
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 30 });
    state().updateTrack(track('Video 2').id, { visible: false });
    expect(coveringClip(state().project, title, 60)).toBeNull();
  });

  it('"Move above" puts it on top, at the same frames, in one undo step', () => {
    add(picture(track('Video 2').id));
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 30 });
    const before = state().project.clips[title];
    const steps = useHistoryStore.getState().undoStack.length;

    state().moveClipsAbove([title]);

    const after = state().project.clips[title];
    const top = timelineRows(state().project.tracks)[0];
    expect(after.trackId).toBe(top.id);
    expect(top.name).toBe('Video 3');
    expect(after.startFrame).toBe(before.startFrame);
    expect(after.durationFrames).toBe(before.durationFrames);
    expect(coveringClip(state().project, title, 60)).toBeNull();
    expect(Compositor.visibleClips(state().project, 60).at(-1)?.id).toBe(title);
    expect(useHistoryStore.getState().undoStack.length).toBe(steps + 1);
    expect(state().ui.selectedTrackId).toBe(top.id);

    state().undo();
    expect(state().project.clips[title].trackId).toBe(track('Video 1').id);
    expect(videoTracks()).toHaveLength(2);
  });

  it('a free track above is used before a new one is made', () => {
    add(picture(track('Video 1').id));
    state().addTrack('video');
    const low = add(picture(track('Video 1').id, { startFrame: 400, name: 'b' }));
    add(picture(track('Video 2').id, { startFrame: 400, name: 'cover' }));
    state().moveClipsAbove([low]);
    expect(state().project.clips[low].trackId).toBe(track('Video 3').id);
    expect(videoTracks()).toHaveLength(3);
  });

  it('a free track that is switched off or locked is passed over', () => {
    add(picture(track('Video 2').id, { name: 'cover' }));
    state().addTrack('video');
    state().addTrack('video');
    state().updateTrack(track('Video 3').id, { visible: false });
    state().updateTrack(track('Video 4').id, { locked: true });
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 30 });
    expect(trackAboveFor(state().project, title)).toBeNull();
    state().moveClipsAbove([title]);
    expect(state().project.clips[title].trackId).toBe(timelineRows(state().project.tracks)[0].id);
    expect(videoTracks()).toHaveLength(5);
  });

  it('a clip on a locked track stays where it is', () => {
    add(picture(track('Video 2').id));
    const title = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 30 });
    state().updateTrack(track('Video 1').id, { locked: true });
    const steps = useHistoryStore.getState().undoStack.length;
    state().moveClipsAbove([title]);
    expect(state().project.clips[title].trackId).toBe(track('Video 1').id);
    expect(useHistoryStore.getState().undoStack.length).toBe(steps);
  });

  it('never moves a clip down: a free track below its own is not "above"', () => {
    // Nothing overlaps it, so the first free track is Video 1, under it.
    const high = add(picture(track('Video 2').id, { name: 'high' }));
    expect(trackAboveFor(state().project, high)).toBe(track('Video 1').id);
    state().moveClipsAbove([high]);
    expect(state().project.clips[high].trackId).toBe(track('Video 2').id);
  });

  it('a new title at the playhead goes above the picture there, and shows', () => {
    add(picture(track('Video 1').id));
    add(picture(track('Video 2').id));
    state().setCurrentFrame(60);
    const title = state().addTitle('title');
    expect(coveringClip(state().project, title, 60)).toBeNull();
    expect(Compositor.visibleClips(state().project, 60).at(-1)?.id).toBe(title);
  });
});

describe('several clips moved above at once', () => {
  it('each goes on top, they keep their order among themselves, and it is one undo step', () => {
    add(picture(track('Video 2').id, { name: 'cover', durationFrames: 600 }));
    const lower = state().addTitle('title', { trackId: track('Video 1').id, startFrame: 0 });
    // A second title over the first, on a track between them.
    state().addTrackAt('video', timelineRows(state().project.tracks).findIndex((row) => row.name === 'Video 1'));
    const middle = timelineRows(state().project.tracks).find((row) => row.type === 'video' && row.order === 1)!;
    const upper = state().addTitle('lowerThird', { trackId: middle.id, startFrame: 0 });
    expect(coveringClip(state().project, lower, 30)).not.toBeNull();
    expect(coveringClip(state().project, upper, 30)).not.toBeNull();
    const steps = useHistoryStore.getState().undoStack.length;

    // Given top first: the store still lifts the lower one first.
    state().moveClipsAbove([upper, lower]);

    expect(coveringClip(state().project, lower, 30)).toBeNull();
    expect(coveringClip(state().project, upper, 30)).toBeNull();
    const drawn = Compositor.visibleClips(state().project, 30).map((clip) => clip.id);
    expect(drawn.slice(-2)).toEqual([lower, upper]);
    expect(useHistoryStore.getState().undoStack.length).toBe(steps + 1);
    state().undo();
    expect(state().project.clips[lower].trackId).toBe(track('Video 1').id);
    expect(state().project.clips[upper].trackId).toBe(middle.id);
  });
});
