import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, MediaAsset, ProjectState } from '@shared/types';
import { contrastOf } from '@shared/utils/contrast';
import {
  assetHasSound,
  bringIntoSync,
  canDetachAudio,
  detachAudio,
  pairedClip,
  rejoinAudio,
  rejoinState,
  syncOffset,
  syncOffsetLabel,
  syncOffsets,
} from '@renderer/components/Timeline/detachAudio';
import { clipKind, trackAccepts } from '@renderer/components/Timeline/trackRows';
import { splitClip } from '@renderer/components/Timeline/timelineOps';
import { clipSounds, mixSignature } from '@renderer/audio/mixRouting';
import { planPlaybackSpans } from '@renderer/audio/playbackSchedule';
import { planScrubGrains } from '@renderer/audio/scrubAudio';
import { LOOP_COLOUR } from '@renderer/components/Timeline/TimelineCanvas';
import { groupSelection } from '@renderer/components/Inspector/multiSelection';
import { isAudioClip } from '@renderer/components/Inspector/Inspector';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Detach audio: a video clip's sound as a clip of its own.
 *
 * What has to hold: the sound lands on an audio track at exactly the same
 * time, reading the same stretch of the file at the same speed, with the same
 * fades and level; the picture's own sound goes quiet everywhere sound is
 * made (playback, scrubbing, the export's choice of clips), so it is heard
 * once; the two are linked; and drift, re-sync and rejoining do what Premiere
 * users expect of them.
 */

const VIDEO = 'blob:video';
const kindOf = (uri: string): MediaAsset['kind'] | undefined => (uri === VIDEO ? 'video' : uri === 'blob:song' ? 'audio' : 'image');

function project(): ProjectState {
  return createEmptyProject(1920, 1080, 30);
}
const videoTrack = (p: ProjectState) => p.tracks.find((track) => track.type === 'video' && track.order === 0)!;
const audioTrack = (p: ProjectState) => p.tracks.find((track) => track.type === 'audio')!;

function withClip(p: ProjectState, clip: Partial<Clip> & { trackId: string }): [ProjectState, Clip] {
  const made = {
    ...createClip({ trackId: clip.trackId, name: 'take.mp4', sourceUri: VIDEO, startFrame: 0, durationFrames: 90 }),
    ...clip,
  } as Clip;
  return [{ ...p, clips: { ...p.clips, [made.id]: made } }, made];
}

describe('detaching', () => {
  it('puts the sound on the audio track at the same time, same stretch, speed, fades and level, linked', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id, startFrame: 30, durationFrames: 60, sourceOffsetFrames: 15, speed: 1.5, fadeInFrames: 6, fadeOutFrames: 9, volume: 0.5, pan: -0.25 });
    const result = detachAudio(p, [picture.id], kindOf);
    expect(result.soundIds).toHaveLength(1);
    const sound = result.project.clips[result.soundIds[0]];
    const after = result.project.clips[picture.id];
    expect(sound.trackId).toBe(audioTrack(p).id);
    expect([sound.startFrame, sound.durationFrames, sound.sourceOffsetFrames, sound.speed]).toEqual([30, 60, 15, 1.5]);
    expect([sound.fadeInFrames, sound.fadeOutFrames, sound.volume, sound.pan]).toEqual([6, 9, 0.5, -0.25]);
    expect(sound.sourceUri).toBe(VIDEO);
    expect(sound.audioOnly).toBe(true);
    expect(after.audioDetached).toBe(true);
    expect(sound.linkGroup).toBeDefined();
    expect(sound.linkGroup).toBe(after.linkGroup);
    // The picture is untouched otherwise.
    expect([after.startFrame, after.durationFrames, after.sourceOffsetFrames]).toEqual([30, 60, 15]);
  });

  it('joins a group the picture was already in', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id, linkGroup: 'link-x' });
    const result = detachAudio(p, [picture.id], kindOf);
    expect(result.project.clips[result.soundIds[0]].linkGroup).toBe('link-x');
  });

  it('makes a new audio track only when none has room, and shares it between back-to-back clips', () => {
    let p = project();
    let a: Clip;
    let b: Clip;
    [p, a] = withClip(p, { trackId: videoTrack(p).id, startFrame: 0, durationFrames: 60 });
    [p, b] = withClip(p, { trackId: videoTrack(p).id, startFrame: 60, durationFrames: 60 });
    // Music in the way on the only audio track.
    [p] = withClip(p, { trackId: audioTrack(p).id, sourceUri: 'blob:song', startFrame: 10, durationFrames: 20 });
    const result = detachAudio(p, [a.id, b.id], kindOf);
    expect(result.project.tracks.filter((track) => track.type === 'audio')).toHaveLength(2);
    const [soundA, soundB] = result.soundIds.map((id) => result.project.clips[id]);
    expect(soundA.trackId).not.toBe(audioTrack(p).id);
    // Back to back on one track, so a crossfade at their cut carries over.
    expect(soundB.trackId).toBe(soundA.trackId);
    expect(soundB.startFrame).toBe(soundA.startFrame + soundA.durationFrames);
  });

  it('gives overlapping clips on two picture tracks a track each', () => {
    let p = project();
    const upper = p.tracks.find((track) => track.type === 'video' && track.order === 1)!;
    let a: Clip;
    let b: Clip;
    [p, a] = withClip(p, { trackId: videoTrack(p).id, startFrame: 0, durationFrames: 60 });
    [p, b] = withClip(p, { trackId: upper.id, startFrame: 30, durationFrames: 60 });
    const result = detachAudio(p, [a.id, b.id], kindOf);
    const tracks = new Set(result.soundIds.map((id) => result.project.clips[id].trackId));
    expect(tracks.size).toBe(2);
  });

  it('leaves alone what has no sound to detach: stills, titles, sound clips, detached pictures, silent videos', () => {
    let p = project();
    let still: Clip;
    let song: Clip;
    [p, still] = withClip(p, { trackId: videoTrack(p).id, sourceUri: 'blob:still' });
    [p, song] = withClip(p, { trackId: audioTrack(p).id, sourceUri: 'blob:song' });
    const track = (clip: Clip) => p.tracks.find((candidate) => candidate.id === clip.trackId);
    expect(canDetachAudio(still, track(still), kindOf)).toBe(false);
    expect(canDetachAudio(song, track(song), kindOf)).toBe(false);
    expect(detachAudio(p, [still.id, song.id], kindOf).soundIds).toEqual([]);

    let video: Clip;
    [p, video] = withClip(p, { trackId: videoTrack(p).id, startFrame: 200 });
    // A video known to be silent: imported from disk with no sound pulled out.
    expect(detachAudio(p, [video.id], kindOf, () => false).soundIds).toEqual([]);
    const once = detachAudio(p, [video.id], kindOf);
    // A second detach of the same picture does nothing.
    expect(detachAudio(once.project, [video.id], kindOf).soundIds).toEqual([]);
  });

  it('knows a silent video from the import: sound pulled out, or never asked', () => {
    expect(assetHasSound({ kind: 'video', sourcePath: 'C:/a.mp4', audioUri: 'blob:a' })).toBe(true);
    expect(assetHasSound({ kind: 'video', sourcePath: 'C:/screen.mp4' })).toBe(false);
    expect(assetHasSound({ kind: 'video' })).toBe(true);
    expect(assetHasSound({ kind: 'image', sourcePath: 'C:/a.png' })).toBe(false);
  });
});

describe('heard once', () => {
  it('silences the picture in every path that makes sound, and keeps the sound clip', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id });
    const detached = detachAudio(p, [picture.id], kindOf).project;
    const soundId = Object.values(detached.clips).find((clip) => clip.audioOnly)!.id;

    expect(clipSounds(detached.clips[picture.id])).toBe(false);
    expect(clipSounds(detached.clips[soundId])).toBe(true);

    const spans = planPlaybackSpans(detached, { fromSeconds: 0, horizonSeconds: 2, chunkSeconds: 0.5, scheduledUntil: new Map(), canStream: () => true });
    expect(new Set(spans.map((span) => span.clipId))).toEqual(new Set([soundId]));
    // Before detaching, the picture was the one sounding.
    const before = planPlaybackSpans(p, { fromSeconds: 0, horizonSeconds: 2, chunkSeconds: 0.5, scheduledUntil: new Map(), canStream: () => true });
    expect(new Set(before.map((span) => span.clipId))).toEqual(new Set([picture.id]));

    expect(planScrubGrains(detached, 10, () => true).map((grain) => grain.clipId)).toEqual([soundId]);
    // Silencing the picture is a change to the mix, so a playing engine hears it at once.
    expect(mixSignature(detached)).not.toBe(mixSignature(p));
  });

  it('keeps the sound on audio tracks wherever it is moved or pasted', () => {
    const sound = { sourceUri: VIDEO, audioOnly: true };
    expect(clipKind(sound, kindOf)).toBe('audio');
    expect(trackAccepts({ type: 'audio' }, clipKind(sound, kindOf))).toBe(true);
    expect(trackAccepts({ type: 'video' }, clipKind(sound, kindOf))).toBe(false);
  });

  it('a cut through a detached pair leaves two detached pairs', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id });
    const detached = detachAudio(p, [picture.id], kindOf).project;
    const [left, right] = splitClip(detached.clips[picture.id], 45)!;
    expect(left.audioDetached && right.audioDetached).toBe(true);
    const sound = Object.values(detached.clips).find((clip) => clip.audioOnly)!;
    const [soundLeft, soundRight] = splitClip(sound, 45)!;
    expect(soundLeft.audioOnly && soundRight.audioOnly).toBe(true);
  });
});

describe('sync', () => {
  function pair(sound: Partial<Clip>): { clips: Record<string, Clip>; picture: Clip; sound: Clip } {
    const picture = { ...createClip({ trackId: 'v', name: 'a', sourceUri: VIDEO, startFrame: 100, durationFrames: 60, sourceOffsetFrames: 30 }), linkGroup: 'g', audioDetached: true } as Clip;
    const audio = { ...createClip({ trackId: 'a', name: 'a', sourceUri: VIDEO, startFrame: 100, durationFrames: 60, sourceOffsetFrames: 30 }), linkGroup: 'g', audioOnly: true, ...sound } as Clip;
    return { clips: { [picture.id]: picture, [audio.id]: audio }, picture, sound: audio };
  }

  it('is in step when the same moment of the file plays at the same moment', () => {
    const { picture, sound } = pair({});
    expect(syncOffset(picture, sound)).toBe(0);
    // Trimmed at the head, both still read the file in step.
    expect(syncOffset(picture, { ...sound, startFrame: 110, sourceOffsetFrames: 40, durationFrames: 50 })).toBe(0);
  });

  it('measures drift in frames: the sound 12 late, 5 early, or slipped', () => {
    expect(syncOffset(pair({}).picture, { ...pair({}).sound, startFrame: 112 })).toBe(12);
    expect(syncOffset(pair({}).picture, { ...pair({}).sound, startFrame: 95 })).toBe(-5);
    // Slipped 6 frames later into the file: what plays now was heard 6 frames ago.
    expect(syncOffset(pair({}).picture, { ...pair({}).sound, sourceOffsetFrames: 36 })).toBe(-6);
    // Different speeds have no single number.
    expect(syncOffset(pair({}).picture, { ...pair({}).sound, speed: 2 })).toBeNull();
  });

  it('marks both parts, each with its own sign, and Premiere-style labels', () => {
    const { clips, picture, sound } = pair({ startFrame: 112 });
    const marks = syncOffsets(clips);
    expect(marks.get(sound.id)).toBe(12);
    expect(marks.get(picture.id)).toBe(-12);
    expect(syncOffsets(pair({}).clips).size).toBe(0);
    expect(syncOffsetLabel(12, 30)).toBe('+12');
    expect(syncOffsetLabel(-35, 30)).toBe('-1:05');
  });

  it('moves into sync, or slips into sync, only the part asked about', () => {
    const { clips, picture, sound } = pair({ startFrame: 112 });
    const moved = bringIntoSync(clips, sound.id, 'move');
    expect(moved[sound.id].startFrame).toBe(100);
    expect(moved[picture.id]).toBe(clips[picture.id]);
    const slipped = bringIntoSync(clips, sound.id, 'slip');
    expect(slipped[sound.id].startFrame).toBe(112);
    expect(syncOffset(slipped[picture.id], slipped[sound.id])).toBe(0);
    // The picture can be the one put back, too.
    const pictureMoved = bringIntoSync(clips, picture.id, 'move');
    expect(pictureMoved[picture.id].startFrame).toBe(112);
  });

  it('refuses a move onto another clip and a slip past the file', () => {
    const { clips, sound } = pair({ startFrame: 112 });
    const blocker = createClip({ trackId: 'a', name: 'x', sourceUri: 'blob:song', startFrame: 50, durationFrames: 60 });
    const crowded = { ...clips, [blocker.id]: blocker };
    expect(bringIntoSync(crowded, sound.id, 'move')).toBe(crowded);
    // 12 frames early: slipped into sync it would play frames 18 to 78 of
    // the file, and this file is 70 frames long.
    const shortFile = pair({ startFrame: 88 });
    expect(bringIntoSync(shortFile.clips, shortFile.sound.id, 'slip', 70)).toBe(shortFile.clips);
  });

  it('finds the partner through the link group and the file', () => {
    const { clips, picture, sound } = pair({});
    expect(pairedClip(clips, picture.id)?.id).toBe(sound.id);
    expect(pairedClip(clips, sound.id)?.id).toBe(picture.id);
    const { linkGroup: _gone, ...unlinked } = sound;
    void _gone;
    expect(pairedClip({ ...clips, [sound.id]: unlinked as Clip }, picture.id)).toBeUndefined();
  });
});

describe('rejoining', () => {
  function detachedProject(): { p: ProjectState; picture: Clip; sound: Clip } {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id });
    const result = detachAudio(p, [picture.id], kindOf);
    return { p: result.project, picture: result.project.clips[picture.id], sound: result.project.clips[result.soundIds[0]] };
  }

  it('puts a sound that still lines up back in its picture, level, pan and EQ with it', () => {
    const { p, picture, sound } = detachedProject();
    const edited = { ...p.clips, [sound.id]: { ...sound, volume: 0.25, pan: 0.5, eq: { low: 3, mid: 0, high: -2 } } };
    expect(rejoinState(edited, sound.id)).toBe('join');
    const result = rejoinAudio(edited, [sound.id]);
    expect(result.joined).toEqual([picture.id]);
    expect(result.clips[sound.id]).toBeUndefined();
    const back = result.clips[picture.id];
    expect(back.audioDetached).toBeUndefined();
    expect([back.volume, back.pan, back.eq.low, back.eq.high]).toEqual([0.25, 0.5, 3, -2]);
    // The group of two is now a group of one, which means nothing.
    expect(back.linkGroup).toBeUndefined();
  });

  it('gives a picture whose sound clip was deleted its own sound back', () => {
    const { p, picture, sound } = detachedProject();
    const { [sound.id]: _deleted, ...rest } = p.clips;
    void _deleted;
    expect(rejoinState(rest, picture.id)).toBe('restore');
    expect(rejoinAudio(rest, [picture.id]).clips[picture.id].audioDetached).toBeUndefined();
  });

  it('leaves alone a sound moved or trimmed apart, and counts it', () => {
    const { p, picture, sound } = detachedProject();
    const apart = { ...p.clips, [sound.id]: { ...sound, startFrame: sound.startFrame + 4 } };
    expect(rejoinState(apart, picture.id)).toBe('apart');
    const result = rejoinAudio(apart, [picture.id]);
    expect(result).toMatchObject({ joined: [], apart: 1 });
    expect(result.clips).toBe(apart);
  });
});

describe('through the store', () => {
  const state = () => useProjectStore.getState();
  const asset: MediaAsset = { id: 'asset-1', name: 'take.mp4', uri: VIDEO, kind: 'video', durationFrames: 300, durationSeconds: 10, width: 1920, height: 1080, hasAlphaChannel: false, sourcePath: 'C:/take.mp4', audioUri: 'blob:take-audio' };

  beforeEach(() => {
    state().newProject(1920, 1080, 30);
    useProjectStore.setState({ assets: [asset] });
    useHistoryStore.getState().clear();
  });

  it('detaches in one undo step, selects the pair, and undoes back to one clip with its sound', () => {
    const track = videoTrack(state().project);
    const id = state().addAssetToTimeline(asset, track.id, 0);
    const depth = useHistoryStore.getState().undoStack.length;
    const made = state().detachAudio([id]);
    expect(made).toHaveLength(1);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    expect(new Set(state().ui.selectedClipIds)).toEqual(new Set([id, made[0]]));
    expect(state().project.clips[id].audioDetached).toBe(true);
    state().undo();
    expect(Object.keys(state().project.clips)).toEqual([id]);
    expect(state().project.clips[id].audioDetached).toBeUndefined();
  });

  it('rejoins in one undo step, and puts drift right with one', () => {
    const track = videoTrack(state().project);
    const id = state().addAssetToTimeline(asset, track.id, 0);
    const [soundId] = state().detachAudio([id]);
    state().setClipStarts(new Map([[soundId, 7]]));
    expect(syncOffsets(state().project.clips).get(soundId)).toBe(7);
    const depth = useHistoryStore.getState().undoStack.length;
    expect(state().bringIntoSync(soundId, 'move')).toBe(true);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    expect(syncOffsets(state().project.clips).size).toBe(0);
    expect(state().rejoinAudio([id])).toEqual({ joined: 1, apart: 0 });
    expect(Object.keys(state().project.clips)).toEqual([id]);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 2);
  });
});

describe('in the inspector', () => {
  const assets: MediaAsset[] = [{ id: 'a', name: 'take.mp4', uri: VIDEO, kind: 'video', durationFrames: 300, durationSeconds: 10, width: 1920, height: 1080, hasAlphaChannel: false }];

  it('several clips: the sound clip takes the volume, the silent picture does not', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id });
    const detached = detachAudio(p, [picture.id], kindOf);
    const sound = detached.soundIds[0];
    const groups = groupSelection([picture.id, sound], detached.project, assets);
    expect(groups.audible.map((clip) => clip.id)).toEqual([sound]);
    expect(groups.visual.map((clip) => clip.id)).toEqual([picture.id]);
    // Before detaching, the picture was the one with a level.
    expect(groupSelection([picture.id], p, assets).audible.map((clip) => clip.id)).toEqual([picture.id]);
  });

  it('one clip: the sound clip is sound, though its file is a video', () => {
    let p = project();
    let picture: Clip;
    [p, picture] = withClip(p, { trackId: videoTrack(p).id });
    const detached = detachAudio(p, [picture.id], kindOf).project;
    const sound = Object.values(detached.clips).find((clip) => clip.audioOnly)!;
    expect(isAudioClip(sound, detached, assets)).toBe(true);
    // By what it is, not only by the track it happens to be on.
    expect(isAudioClip({ ...sound, trackId: 'not-a-track' }, detached, assets)).toBe(true);
    expect(isAudioClip(detached.clips[picture.id], detached, assets)).toBe(false);
  });
});

describe('what the timeline draws', () => {
  it('draws the loop bar and the sync mark with enough contrast', () => {
    // The ruler's background, and white on the mark's red.
    expect(contrastOf(LOOP_COLOUR, '#1d2025')!).toBeGreaterThanOrEqual(3);
    expect(contrastOf('#ffffff', '#dc2626')!).toBeGreaterThanOrEqual(4.5);
  });
});
