import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import {
  activeTransitionsAt,
  createTransition,
  extendedSourceFrame,
  headHandle,
  neededHandles,
  normalizeTransitions,
  overlapClips,
  planTransition,
  tailHandle,
  tidyTransitions,
  transitionProgress,
  transitionWindow,
  trimHead,
  trimTail,
} from '@renderer/timing/transitions';
import { sourceFrameFor } from '@renderer/timing/clipSpeed';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip, normalizeProject } from '@renderer/store/types';
import type { MediaAsset } from '@shared/types';

/**
 * Transitions, phase 3: the handle arithmetic (at other speeds and
 * reversed), where a transition sits, what an overlap does to the edit, and
 * how transitions follow the cuts they sit on. The pixels are
 * tests/ui/transitions.mjs.
 */

const clip = (patch: Partial<Clip>): Clip => ({
  ...createClip({ trackId: 'v1', name: patch.name ?? 'c', sourceUri: patch.sourceUri ?? 'media://a', startFrame: 0, durationFrames: 60 }),
  ...patch,
});

describe('handles', () => {
  // A 300-frame file; the clip shows frames 100..159.
  const middle = clip({ sourceOffsetFrames: 100, durationFrames: 60 });

  it('are the footage past the end and before the start', () => {
    expect(tailHandle(middle, 300)).toBe(140);
    expect(headHandle(middle, 300)).toBe(100);
    // A whole clip has none; a still or a title never runs out.
    const whole = clip({ sourceOffsetFrames: 0, durationFrames: 300 });
    expect(tailHandle(whole, 300)).toBe(0);
    expect(headHandle(whole, 300)).toBe(0);
    expect(tailHandle(whole, undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('are counted at the clip\'s speed: twice as fast uses footage twice as fast', () => {
    // At 200% the 60 frames show 120 of footage: 100..219, leaving 80 after.
    const fast = clip({ sourceOffsetFrames: 100, durationFrames: 60, speed: 2 });
    expect(tailHandle(fast, 300)).toBe(40);
    expect(headHandle(fast, 300)).toBe(50);
    const slow = clip({ sourceOffsetFrames: 100, durationFrames: 60, speed: 0.5 });
    expect(tailHandle(slow, 300)).toBe(340);
    expect(headHandle(slow, 300)).toBe(200);
  });

  it('are the other way round for a reversed clip: past its end is before its footage', () => {
    const reversed = clip({ sourceOffsetFrames: 100, durationFrames: 60, reversed: true });
    expect(tailHandle(reversed, 300)).toBe(100);
    expect(headHandle(reversed, 300)).toBe(140);
  });

  it('extend the picture past the clip, and hold the last frame where the file ends', () => {
    // Forward: one frame past the end is the next frame of footage.
    expect(extendedSourceFrame(middle, 60, 300)).toBe(160);
    expect(extendedSourceFrame(middle, -1, 300)).toBe(99);
    // Inside the clip it is exactly what the clip shows.
    for (const at of [0, 30, 59]) expect(extendedSourceFrame(middle, at, 300)).toBe(sourceFrameFor(middle, at));
    // Reversed runs on backwards into earlier footage.
    const reversed = clip({ sourceOffsetFrames: 100, durationFrames: 60, reversed: true });
    for (const at of [0, 30, 59]) expect(extendedSourceFrame(reversed, at, 300)).toBe(sourceFrameFor(reversed, at));
    expect(extendedSourceFrame(reversed, 60, 300)).toBe(99);
    // Held where the file runs out: frozen frames.
    const whole = clip({ sourceOffsetFrames: 0, durationFrames: 300 });
    expect(extendedSourceFrame(whole, 310, 300)).toBe(299);
    expect(extendedSourceFrame(whole, -10, 300)).toBe(0);
  });
});

describe('where a transition sits', () => {
  it('centred when both clips have the footage, half each side', () => {
    expect(planTransition(100, 100, 30)).toEqual({ alignment: 'center', shortTail: 0, shortHead: 0 });
    expect(neededHandles(30, 'center')).toEqual({ tail: 15, head: 15 });
    expect(neededHandles(31, 'center')).toEqual({ tail: 16, head: 15 });
  });

  it('wholly on the side that has footage when only one does', () => {
    expect(planTransition(40, 0, 30).alignment).toBe('start');
    expect(planTransition(0, 40, 30).alignment).toBe('end');
    expect(neededHandles(30, 'start')).toEqual({ tail: 30, head: 0 });
  });

  it('short on both sides when neither has enough - which is when the editor is asked', () => {
    expect(planTransition(0, 0, 30)).toEqual({ alignment: 'center', shortTail: 15, shortHead: 15 });
    expect(planTransition(10, 20, 30)).toEqual({ alignment: 'center', shortTail: 5, shortHead: 0 });
  });

  it('covers its window, and is half-way through exactly on a centred cut', () => {
    const from = clip({ startFrame: 100, durationFrames: 60 });
    const window = transitionWindow({ durationFrames: 30, alignment: 'center' }, from);
    expect(window).toEqual({ start: 145, end: 175, cut: 160 });
    expect(transitionProgress(145, window)).toBe(0);
    expect(transitionProgress(160, window)).toBe(0.5);
    expect(transitionProgress(174, window)).toBeCloseTo(29 / 30, 12);
  });
});

describe('overlapping', () => {
  const a = clip({ id: 'a', name: 'a', startFrame: 0, durationFrames: 90, sourceOffsetFrames: 0 });
  const b = clip({ id: 'b', name: 'b', startFrame: 90, durationFrames: 90, sourceOffsetFrames: 0 });
  const c = clip({ id: 'c', name: 'c', startFrame: 180, durationFrames: 60, sourceOffsetFrames: 0 });
  const music = clip({ id: 'm', name: 'music', trackId: 'a1', startFrame: 120, durationFrames: 200 });

  it('shortens both clips by what is missing and moves the rest of the track up: N frames shorter', () => {
    const plan = overlapClips({ a, b, c, m: music }, a, b, 15, 15);
    expect(plan.shift).toBe(30);
    expect(plan.clips.a.durationFrames).toBe(75);
    // B lost its first 15 frames and starts where A now ends.
    expect(plan.clips.b.sourceOffsetFrames).toBe(15);
    expect(plan.clips.b.startFrame).toBe(75);
    expect(plan.clips.b.durationFrames).toBe(75);
    expect(plan.clips.c.startFrame).toBe(150);
    const end = (clips: Record<string, Clip>) => Math.max(...['a', 'b', 'c'].map((id) => clips[id].startFrame + clips[id].durationFrames));
    expect(end({ a, b, c })).toBe(240);
    expect(end(plan.clips)).toBe(210);
    // Afterwards both sides have exactly the footage a centred 30-frame transition needs.
    expect(tailHandle(plan.clips.a, 90)).toBe(15);
    expect(headHandle(plan.clips.b, 90)).toBe(15);
  });

  it('says which clips on other tracks it would leave out of step', () => {
    const plan = overlapClips({ a, b, c, m: music }, a, b, 15, 15);
    expect(plan.leftBehind.map((left) => left.name)).toEqual(['music']);
    expect(plan.clips.m.startFrame).toBe(120);
  });

  it('takes linked sound with it', () => {
    const linked = { a: { ...a, linkGroup: 'g1' }, b: { ...b, linkGroup: 'g2' }, sa: clip({ id: 'sa', trackId: 'a1', startFrame: 0, durationFrames: 90, linkGroup: 'g1' }), sb: clip({ id: 'sb', trackId: 'a1', startFrame: 90, durationFrames: 90, linkGroup: 'g2' }) };
    const plan = overlapClips(linked, linked.a, linked.b, 10, 10);
    expect(plan.clips.sa.durationFrames).toBe(80);
    expect(plan.clips.sb.startFrame).toBe(80);
    expect(plan.clips.sb.sourceOffsetFrames).toBe(10);
    expect(plan.leftBehind).toHaveLength(0);
  });

  it('trims at the clip\'s speed and direction, keeping what it shows', () => {
    const fast = clip({ startFrame: 0, durationFrames: 60, sourceOffsetFrames: 0, speed: 2 });
    const headless = trimHead(fast, 10);
    expect(headless.sourceOffsetFrames).toBe(20);
    expect(sourceFrameFor(headless, 10)).toBe(sourceFrameFor(fast, 10));
    const reversed = clip({ startFrame: 0, durationFrames: 60, sourceOffsetFrames: 50, reversed: true });
    const tailless = trimTail(reversed, 10);
    for (const at of [0, 25, 49]) expect(sourceFrameFor(tailless, at)).toBe(sourceFrameFor(reversed, at));
    const headlessReversed = trimHead(reversed, 10);
    for (const at of [10, 30, 59]) expect(sourceFrameFor(headlessReversed, at)).toBe(sourceFrameFor(reversed, at));
  });
});

describe('transitions follow their cuts', () => {
  const project = (clips: Clip[], transitions = {}): ProjectState => ({
    ...useProjectStore.getState().project,
    clips: Object.fromEntries(clips.map((one) => [one.id, one])),
    transitions,
  });
  const a = clip({ id: 'a', startFrame: 0, durationFrames: 90 });
  const b = clip({ id: 'b', startFrame: 90, durationFrames: 90 });
  const dissolve = createTransition(a, b, 'crossDissolve', 30, 'center');

  it('stays while the clips touch', () => {
    const kept = project([a, b], { [dissolve.id]: dissolve });
    expect(tidyTransitions(kept)).toBe(kept);
  });

  it('goes when a clip is moved away or deleted', () => {
    expect(tidyTransitions(project([a, { ...b, startFrame: 100 }], { [dissolve.id]: dissolve })).transitions).toEqual({});
    expect(tidyTransitions(project([a], { [dissolve.id]: dissolve })).transitions).toEqual({});
  });

  it('moves to the right half when the outgoing clip is split', () => {
    const left = { ...a, durationFrames: 40 };
    const right = clip({ id: 'a2', startFrame: 40, durationFrames: 50 });
    const tidied = tidyTransitions(project([left, right, b], { [dissolve.id]: dissolve }));
    expect(tidied.transitions?.[dissolve.id]?.fromClipId).toBe('a2');
  });

  it('reads from a file with anything broken put right or dropped', () => {
    const read = normalizeTransitions({ x: { id: 'x', fromClipId: 'a', toClipId: 'b', kind: 'spin', durationFrames: 1, alignment: 'sideways', color: 'red' }, y: { id: 'y' } });
    expect(read).toEqual({ x: { id: 'x', fromClipId: 'a', toClipId: 'b', kind: 'crossDissolve', durationFrames: 2, alignment: 'center', color: '#000000' } });
    // A project from before transitions has none, and no field.
    expect(normalizeProject(project([a, b], undefined)).transitions).toBeUndefined();
  });

  it('is on screen over its window only, on visible picture tracks', () => {
    const base = project([{ ...a, trackId: useProjectStore.getState().project.tracks[0].id }, { ...b, trackId: useProjectStore.getState().project.tracks[0].id }], { [dissolve.id]: dissolve });
    expect(activeTransitionsAt(base, 74)).toHaveLength(0);
    expect(activeTransitionsAt(base, 75)[0]?.progress).toBe(0);
    expect(activeTransitionsAt(base, 90)[0]?.progress).toBe(0.5);
    expect(activeTransitionsAt(base, 105)).toHaveLength(0);
  });
});

describe('Ctrl+T in the store', () => {
  const state = () => useProjectStore.getState();
  let v1 = '';
  const video = (name: string, frames: number): MediaAsset => ({
    id: `asset-${name}`, name, uri: `media://${name}`, kind: 'video', durationFrames: frames, durationSeconds: frames / 30, width: 1920, height: 1080,
    hasAlphaChannel: false, sourceFps: 30,
  }) as MediaAsset;

  beforeEach(() => {
    state().newProject();
    useHistoryStore.getState().clear();
    v1 = timelineRows(state().project.tracks)[1].id;
    useProjectStore.setState({ assets: [video('long', 600)] });
  });

  const put = (id: string, start: number, duration: number, offset: number): void => {
    const one = { ...createClip({ trackId: v1, name: id, sourceUri: 'media://long', startFrame: start, durationFrames: duration, sourceOffsetFrames: offset }), id };
    state().transact('seed', (project) => ({ ...project, clips: { ...project.clips, [one.id]: one } }));
  };

  it('adds a centred one-second dissolve on the cut nearest the playhead when there is footage', () => {
    put('a', 0, 90, 100);
    put('b', 90, 90, 300);
    state().setCurrentFrame(95);
    const depth = useHistoryStore.getState().undoStack.length;
    state().addTransitions();
    const [added] = Object.values(state().project.transitions ?? {});
    expect(added).toMatchObject({ fromClipId: 'a', toClipId: 'b', kind: 'crossDissolve', durationFrames: 30, alignment: 'center' });
    expect(state().ui.pendingTransition).toBeNull();
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    expect(state().ui.selectedTransitionId).toBe(added.id);
  });

  it('asks when the footage is not there, and does what the answer says, as one step', () => {
    // A shows the last 90 frames of the file, B the first 90: neither has any beyond the cut.
    put('a', 0, 90, 510);
    put('b', 90, 90, 0);
    state().selectClips(['b']);
    state().addTransitions('dipToBlack');
    const asked = state().ui.pendingTransition;
    expect(asked?.short).toHaveLength(1);
    expect(asked?.overlapFrames).toBe(30);
    expect(state().project.transitions ?? {}).toEqual({});

    // Cancel: nothing.
    state().resolvePendingTransition('cancel');
    expect(state().project.transitions ?? {}).toEqual({});

    // Freeze: nothing moves.
    state().selectClips(['b']);
    state().addTransitions('dipToBlack');
    const depth = useHistoryStore.getState().undoStack.length;
    state().resolvePendingTransition('freeze');
    expect(Object.values(state().project.transitions ?? {})[0]).toMatchObject({ kind: 'dip', color: '#000000', alignment: 'center' });
    expect(state().project.clips.b.startFrame).toBe(90);
    // B's far end had no neighbour: it got a one-second fade.
    expect(state().project.clips.b.fadeOutFrames).toBe(30);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    state().undo();
    expect(state().project.transitions ?? {}).toEqual({});

    // Overlap: 15 off each clip, the track 30 frames shorter.
    state().selectClips(['b']);
    state().addTransitions();
    state().resolvePendingTransition('overlap');
    expect(state().project.clips.a.durationFrames).toBe(75);
    expect(state().project.clips.b.startFrame).toBe(75);
    expect(state().project.clips.b.sourceOffsetFrames).toBe(15);
  });
});

describe('on the timeline', () => {
  it('draws the box across the window of the cut, and at least 12 px wide', async () => {
    const { transitionBoxes, transitionAt, durationFromEdge } = await import('@renderer/components/Timeline/transitionBoxes');
    const a = clip({ id: 'a', startFrame: 0, durationFrames: 90 });
    const b = clip({ id: 'b', startFrame: 90, durationFrames: 90 });
    const dissolve = createTransition(a, b, 'crossDissolve', 30, 'center');
    const tracks = [{ id: 'v1' } as never];
    const rows = { rowTop: (index: number) => 24 + index * 58, rowHeight: 56 };
    const [box] = transitionBoxes({ clips: { a, b }, transitions: { [dissolve.id]: dissolve } }, tracks, { pixelsPerFrame: 2, scrollLeftPx: 0 }, rows);
    expect(box).toMatchObject({ cutX: 180, left: 150, right: 210 });
    expect(transitionAt([box], 180, box.top + 5)?.edge).toBeNull();
    expect(transitionAt([box], 151, box.top + 5)?.edge).toBe('start');
    expect(transitionAt([box], 180, box.top - 5)).toBeNull();
    const [tiny] = transitionBoxes({ clips: { a, b }, transitions: { [dissolve.id]: dissolve } }, tracks, { pixelsPerFrame: 0.1, scrollLeftPx: 0 }, rows);
    expect(tiny.right - tiny.left).toBe(12);
    // A centred one grows both ways from the cut; one starting at the cut grows away from it.
    expect(durationFromEdge({ alignment: 'center' }, 90, 110)).toBe(40);
    expect(durationFromEdge({ alignment: 'center' }, 90, 75)).toBe(30);
    expect(durationFromEdge({ alignment: 'start' }, 90, 110)).toBe(20);
    expect(durationFromEdge({ alignment: 'end' }, 90, 70)).toBe(20);
  });

  it('keeps clip names and the red edge readable', async () => {
    const { CLIP_NAME, TRACK_TYPE_COLORS, TRANSITION_SHORT } = await import('@renderer/components/Timeline/TimelineCanvas');
    const { contrastOf, SHAPE_CONTRAST, TEXT_CONTRAST } = await import('@shared/utils/contrast');
    for (const colour of Object.values(TRACK_TYPE_COLORS)) expect(contrastOf(CLIP_NAME, colour)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    // The red edge on its dark box, and against the clip colours beside it.
    expect(contrastOf(TRANSITION_SHORT, '#0c0e12')).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
  });
});
