import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptionWord, Clip, MediaAsset } from '@shared/types';
import type { Cue } from '@renderer/captions/rules';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { normalizeProject } from '@renderer/store/types';

/**
 * Captions follow the edit (captions/follow.ts), through the store, the way
 * the editor drives it: a clip is moved, trimmed, deleted, cut or retimed,
 * and its captions are where its footage is afterwards.
 *
 * Two clips of speech on Video 1, 30 fps:
 *   A  0..600    (20 s of a.mp4)    captions at 1-2 s, 3-4.5 s, 9.5-10.5 s, 12-13 s
 *   B  900..1200 (10 s of b.mp4)    a caption at 31-32 s of the timeline (1-2 s of b.mp4)
 */

const FPS = 30;

const asset = (name: string, seconds: number, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id: `asset-${name}`,
  name,
  uri: `blob:${name}`,
  kind: 'video',
  durationFrames: seconds * FPS,
  durationSeconds: seconds,
  width: 1920,
  height: 1080,
  hasAlphaChannel: false,
  audioUri: `blob:${name}-audio`,
  ...extra,
});

/** A cue with a word a second: the words cover the cue, the cue holds 0.4 s after them. */
function cue(start: number, end: number, text: string): Cue {
  const parts = text.split(' ');
  const length = (end - start) / parts.length;
  const words: CaptionWord[] = parts.map((word, index) => ({ text: word, start: start + index * length, end: start + (index + 1) * length }));
  return { start, end: end + 0.4, lines: [text], words };
}

const CUES: Cue[] = [cue(1, 2, 'uno dos'), cue(3, 4.5, 'tres cuatro cinco'), cue(9.5, 10.5, 'nueve diez'), cue(12, 13, 'doce trece'), cue(31, 32, 'treinta y uno')];

const store = () => useProjectStore.getState();
const captions = (): Clip[] =>
  Object.values(store().project.clips)
    .filter((clip) => clip.caption)
    .sort((a, b) => a.startFrame - b.startFrame);
const byText = (text: string): Clip | undefined => captions().find((clip) => clip.caption?.text === text) ?? Object.values(store().project.parkedCaptions ?? {}).find((clip) => clip.caption?.text === text);
const span = (text: string): [number, number] | 'parked' | 'gone' => {
  const clip = captions().find((candidate) => candidate.caption?.text === text);
  if (clip) return [clip.startFrame, clip.startFrame + clip.durationFrames];
  return Object.values(store().project.parkedCaptions ?? {}).some((candidate) => candidate.caption?.text === text) ? 'parked' : 'gone';
};
const parkedCount = (): number => Object.keys(store().project.parkedCaptions ?? {}).length;

let clipA = '';
let clipB = '';
let trackId = '';

beforeEach(() => {
  store().newProject(1920, 1080, FPS);
  useHistoryStore.getState().clear();
  store().setUi({ rippleEnabled: true, snappingEnabled: false });
  const a = asset('a.mp4', 20);
  const b = asset('b.mp4', 10);
  store().addAssets([a, b]);
  const video = store().project.tracks.find((track) => track.type === 'video' && track.order === 0) as { id: string };
  clipA = store().addAssetToTimeline(a, video.id, 0);
  clipB = store().addAssetToTimeline(b, video.id, 900);
  trackId = store().addCaptionTrack({ cues: CUES, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
});

describe('captions follow their footage', () => {
  it('are tied, when transcribed, to the clip they were heard in - and stay exactly where the rules put them', () => {
    expect(captions().map((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames])).toEqual([[30, 72], [90, 147], [285, 327], [360, 402], [930, 972]]);
    expect(captions().map((clip) => clip.caption?.link?.clipId)).toEqual([clipA, clipA, clipA, clipA, clipB]);
    const link = byText('uno dos')?.caption?.link;
    // Seconds of the footage: the words run from 1 to 2, and the caption holds 0.4 s after them.
    expect(link).toMatchObject({ sourceUri: 'blob:a.mp4', from: 1, to: 2, origin: 1 });
    expect(link?.hold).toBeCloseTo(0.4, 6);
    expect(byText('treinta y uno')?.caption?.link).toMatchObject({ sourceUri: 'blob:b.mp4', from: 1, to: 2 });
    // One undo step still: the tying is part of adding them.
    expect(useHistoryStore.getState().undoStack).toHaveLength(3);
  });

  it('a moved clip takes its captions with it, and only its own', () => {
    store().moveClipGroup([clipB], 150, 0);
    expect(span('treinta y uno')).toEqual([1080, 1122]);
    expect(span('uno dos')).toEqual([30, 72]);
    store().undo();
    expect(span('treinta y uno')).toEqual([930, 972]);
  });

  it('a drag that holds still for a frame does not let go of them', () => {
    // The timeline moves a clip from where the drag began, again and again.
    const base = store().project.clips;
    for (const delta of [40, 40, 150, 150, 90]) store().moveClipGroup([clipB], delta, 0, { base, mergeKey: 'drag' });
    expect(store().project.clips[clipB].startFrame).toBe(990);
    expect(span('treinta y uno')).toEqual([1020, 1062]);
    expect(byText('treinta y uno')?.caption?.link?.clipId).toBe(clipB);
    store().undo();
    expect(span('treinta y uno')).toEqual([930, 972]);
  });

  it('deleting a clip with the magnet: its captions are put away, the rest ride the ripple - and undo brings all back', () => {
    store().removeClips([clipA]);
    // B closed up by A's 600 frames, and its caption with it.
    expect(store().project.clips[clipB].startFrame).toBe(300);
    expect(span('treinta y uno')).toEqual([330, 372]);
    expect(['uno dos', 'tres cuatro cinco', 'nueve diez', 'doce trece'].map(span)).toEqual(['parked', 'parked', 'parked', 'parked']);
    expect(captions()).toHaveLength(1);
    store().undo();
    expect(parkedCount()).toBe(0);
    expect(captions().map((clip) => clip.startFrame)).toEqual([30, 90, 285, 360, 930]);
  });

  it('trimming a clip: a caption cut into is shortened, one trimmed away is put away, and trimming back restores both', () => {
    // The first second and a half of A goes: "uno dos" (words from 1 s to 2 s) loses its first half.
    store().trimClip(clipA, 'start', 45);
    expect(store().project.clips[clipA]).toMatchObject({ startFrame: 45, sourceOffsetFrames: 45 });
    expect(span('uno dos')).toEqual([45, 72]);
    // Its words still say when they were spoken: "dos" starts on frame 45.
    const cut = byText('uno dos') as Clip;
    const dos = cut.caption?.words?.[1] as CaptionWord;
    expect(cut.startFrame + (dos.start * FPS - cut.sourceOffsetFrames)).toBeCloseTo(45, 6);
    expect(span('tres cuatro cinco')).toEqual([90, 147]);

    // Three seconds gone: its words are not in the edit at all.
    store().trimClip(clipA, 'start', 100);
    expect(span('uno dos')).toBe('parked');
    expect(span('tres cuatro cinco')).toEqual([100, 147]);

    // And back out to where it began.
    store().trimClip(clipA, 'start', 0);
    expect(span('uno dos')).toEqual([30, 72]);
    expect(span('tres cuatro cinco')).toEqual([90, 147]);
    expect(byText('uno dos')?.sourceOffsetFrames).toBe(0);
    expect(parkedCount()).toBe(0);
  });

  it('trimming a clip\'s end with the magnet: what follows closes up, captions included', () => {
    // A ends at 12.5 s instead of 20: "doce trece" (12-13 s) keeps its first half; B rides in.
    store().trimClip(clipA, 'end', 375);
    expect(span('doce trece')).toEqual([360, 375]);
    expect(span('nueve diez')).toEqual([285, 327]);
  });

  it('cutting a clip moves nothing; each caption then follows the half its words are in', () => {
    store().razorAtFrame(300, [clipA]);
    expect(captions().map((clip) => clip.startFrame)).toEqual([30, 90, 285, 360, 930]);
    // "nueve diez" straddles the cut and is whole while the halves touch.
    expect(span('nueve diez')).toEqual([285, 327]);
    const right = Object.values(store().project.clips).find((clip) => clip.sourceUri === 'blob:a.mp4' && clip.startFrame === 300) as Clip;

    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([right.id], 240, 0);
    // The right half went 8 seconds later, and what was said in it went too.
    expect(span('doce trece')).toEqual([600, 642]);
    expect(byText('doce trece')?.caption?.link?.clipId).toBe(right.id);
    expect(span('uno dos')).toEqual([30, 72]);
    // The one across the cut stays with the half it was tied to, and ends on the cut.
    expect(span('nueve diez')).toEqual([285, 300]);
    expect(byText('nueve diez')?.caption?.link?.clipId).toBe(clipA);
  });

  it('a clip sped up or slowed down: its captions keep its pace; played backwards, they are put away', () => {
    store().setClipSpeed(clipA, { speed: 2, reversed: false, ripple: false });
    expect(store().project.clips[clipA].durationFrames).toBe(300);
    // Words from 1 s to 2 s of footage are now from 0.5 s to 1 s; the 0.4 s it holds after them is unchanged.
    expect(span('uno dos')).toEqual([15, 42]);
    const fast = byText('uno dos') as Clip;
    expect(fast.speed).toBe(2);
    const dos = fast.caption?.words?.[1] as CaptionWord;
    expect(fast.startFrame + (dos.start * FPS - fast.sourceOffsetFrames) / 2).toBeCloseTo(22.5, 6);

    store().setClipSpeed(clipA, { speed: 1, reversed: true, ripple: false });
    expect(['uno dos', 'tres cuatro cinco', 'nueve diez', 'doce trece'].map(span)).toEqual(['parked', 'parked', 'parked', 'parked']);
    store().setClipSpeed(clipA, { speed: 1, reversed: false, ripple: false });
    expect(span('uno dos')).toEqual([30, 72]);
    expect(byText('uno dos')?.speed).toBeUndefined();
  });

  it('a caption moved or trimmed by hand is tied again from where it was put', () => {
    const id = (byText('tres cuatro cinco') as Clip).id;
    store().moveClipTo(id, trackId, 100);
    expect(span('tres cuatro cinco')).toEqual([100, 157]);
    store().trimClip(id, 'end', 150);
    expect(span('tres cuatro cinco')).toEqual([100, 150]);
    // It follows the clip from its new place.
    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([clipA, clipB], 60, 0);
    expect(span('tres cuatro cinco')).toEqual([160, 210]);
    expect(span('uno dos')).toEqual([90, 132]);
  });

  it('a caption moved to where there is no sound is set free, and stays there', () => {
    const id = (byText('doce trece') as Clip).id;
    store().moveClipTo(id, trackId, 700);
    expect(span('doce trece')).toEqual([700, 742]);
    expect(byText('doce trece')?.caption?.link).toBeUndefined();
    store().removeClips([clipA]);
    expect(span('doce trece')).toEqual([700, 742]);
  });

  it('unlinked, a caption stays where it is; linked again, it follows again', () => {
    const id = (byText('uno dos') as Clip).id;
    store().unlinkCaptionsFromClips([id]);
    expect(byText('uno dos')?.caption?.link).toBeUndefined();
    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([clipA], 200, 0);
    expect(span('uno dos')).toEqual([30, 72]);
    expect(span('tres cuatro cinco')).toEqual([290, 347]);
    store().moveClipGroup([clipA], -200, 0);
    expect(store().linkCaptionsToClips([id])).toBe(1);
    store().moveClipGroup([clipA], 60, 0);
    expect(span('uno dos')).toEqual([90, 132]);
  });

  it('captions read from a file are not tied to anything, until asked', () => {
    const imported = store().addCaptionTrack({ subtitles: [{ startMs: 1000, endMs: 2000, text: 'de un archivo' }] }, { preset: 'classic', language: 'es' });
    const clip = Object.values(store().project.clips).find((candidate) => candidate.trackId === imported) as Clip;
    expect(clip.caption).toMatchObject({ manualBreaks: true });
    expect(clip.caption?.link).toBeUndefined();
    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([clipA], 60, 0);
    expect(store().project.clips[clip.id].startFrame).toBe(30);
    store().moveClipGroup([clipA], -60, 0);
    expect(store().linkCaptionsToClips([clip.id])).toBe(1);
    store().moveClipGroup([clipA], 60, 0);
    expect(store().project.clips[clip.id].startFrame).toBe(90);
  });

  it('a locked captions track is left exactly as it is', () => {
    store().updateTrack(trackId, { locked: true });
    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([clipA], 60, 0);
    expect(span('uno dos')).toEqual([30, 72]);
  });

  it('deleting the captions track takes its put-away captions with it', () => {
    store().removeClips([clipA]);
    expect(parkedCount()).toBe(4);
    store().removeTrack(trackId);
    expect(parkedCount()).toBe(0);
    expect(store().project.parkedCaptions).toBeUndefined();
  });

  it('the footage coming back - the same file added again - brings its captions back', () => {
    store().setUi({ rippleEnabled: false });
    store().removeClips([clipA]);
    expect(parkedCount()).toBe(4);
    const video2 = store().project.tracks.find((track) => track.type === 'video' && track.order === 1) as { id: string };
    const again = store().addAssetToTimeline(store().assets[0], video2.id, 1500);
    expect(parkedCount()).toBe(0);
    expect(span('uno dos')).toEqual([1530, 1572]);
    expect(byText('uno dos')?.caption?.link?.clipId).toBe(again);
  });

  it('two captions never end up on the same frames: the earlier one gives way', () => {
    // B is dragged over A's time, on another track: its caption lands inside one of A's.
    store().setUi({ rippleEnabled: false });
    const video2 = store().project.tracks.find((track) => track.type === 'video' && track.order === 1) as { id: string };
    store().moveClipTo(clipB, video2.id, 80);
    const row = captions();
    for (let i = 0; i + 1 < row.length; i += 1) expect(row[i].startFrame + row[i].durationFrames).toBeLessThanOrEqual(row[i + 1].startFrame);
    expect(span('treinta y uno')).toEqual([110, 152]);
    expect(span('tres cuatro cinco')).toEqual([90, 110]);
  });

  it('a change of frame rate keeps every caption on its words', () => {
    store().setProjectSettings({ fps: 60 });
    expect(store().project.clips[clipA].durationFrames).toBe(1200);
    expect(span('uno dos')).toEqual([60, 144]);
    expect(span('treinta y uno')).toEqual([1860, 1944]);
    // And they still follow.
    store().setUi({ rippleEnabled: false });
    store().moveClipGroup([clipB], 120, 0);
    expect(span('treinta y uno')).toEqual([1980, 2064]);
  });

  it('put-away captions are saved with the project and come back when it is opened', () => {
    store().trimClip(clipA, 'start', 100);
    expect(parkedCount()).toBe(1);
    const saved = JSON.parse(JSON.stringify(store().project));
    const opened = normalizeProject(saved);
    expect(opened).toEqual(saved);
    expect(Object.values(opened.parkedCaptions ?? {})[0].caption?.text).toBe('uno dos');
    // A parked caption that is also on the timeline, or belongs to no captions track, is not kept.
    const damaged = JSON.parse(JSON.stringify(saved));
    damaged.parkedCaptions.stray = { ...(Object.values(saved.parkedCaptions)[0] as Clip), id: 'stray', trackId: 'nowhere' };
    expect(Object.keys(normalizeProject(damaged).parkedCaptions ?? {})).toHaveLength(1);
  });

  it('an edit that touches neither a clip nor a caption changes nothing about them', () => {
    const before = store().project.clips;
    store().addMarker(10);
    expect(store().project.clips).toBe(before);
  });
});
