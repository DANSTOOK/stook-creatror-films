import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { Compositor } from '@renderer/engine/Compositor';
import {
  nextTrackName,
  timelineRows,
  trackAccepts,
  withRowOrders,
} from '@renderer/components/Timeline/trackRows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip, createTrack } from '@renderer/store/types';

/**
 * Point 7: several video and audio tracks, laid out and stacked the way every
 * editor does it.
 */

const state = () => useProjectStore.getState();
const rowNames = () => timelineRows(state().project.tracks).map((track) => track.name);

const asset = (kind: MediaAsset['kind'], uri: string): MediaAsset => ({
  id: uri, name: uri, uri, kind, durationFrames: 300, width: 640, height: 360, hasAlphaChannel: false,
});

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
});

describe('stacking', () => {
  it('draws the top row over the rows below it', () => {
    const rows = timelineRows(state().project.tracks);
    const [top, below] = rows;
    const low = createClip({ trackId: below.id, name: 'low', sourceUri: 'media://a', startFrame: 0, durationFrames: 30 });
    const high = createClip({ trackId: top.id, name: 'high', sourceUri: 'media://b', startFrame: 0, durationFrames: 30 });
    const project = { ...state().project, clips: { [low.id]: low, [high.id]: high } };

    // Painted in this order, so the last one is on top.
    expect(Compositor.visibleClips(project, 10).map((clip) => clip.name)).toEqual(['low', 'high']);
  });

  it('keeps an older project looking the same: only its rows are shown the other way up', () => {
    // Before: Video 1 (order 0) as the first row, Video 2 (order 1) drawn over it.
    const old = [createTrack('video', 0, 'Video 1'), createTrack('video', 1, 'Video 2'), createTrack('audio', 2, 'Audio 1')];
    const rows = timelineRows(old);
    expect(rows.map((t) => t.name)).toEqual(['Video 2', 'Video 1', 'Audio 1']);
    // Renumbering from the rows gives back the very same stacking.
    const orders = Object.fromEntries(withRowOrders(rows).map((t) => [t.name, t.order]));
    expect(orders).toEqual({ 'Video 1': 0, 'Video 2': 1, 'Audio 1': 2 });
  });
});

describe('adding tracks', () => {
  it('puts a new video track on top, numbered on', () => {
    state().addTrack('video');
    expect(rowNames()).toEqual(['Video 3', 'Video 2', 'Video 1', 'Audio 1']);
  });

  it('puts a new audio track under the last one', () => {
    state().addTrack('audio');
    state().addTrack('audio');
    expect(rowNames()).toEqual(['Video 2', 'Video 1', 'Audio 1', 'Audio 2', 'Audio 3']);
  });

  it('a new video track covers everything below it', () => {
    state().addTrack('video');
    const top = timelineRows(state().project.tracks)[0];
    const highest = Math.max(...state().project.tracks.filter((t) => t.type !== 'audio').map((t) => t.order));
    expect(top.order).toBe(highest);
  });

  it('never reuses a number that is already taken', () => {
    const tracks = [createTrack('video', 0, 'Video 1'), createTrack('video', 1, 'Video 7')];
    expect(nextTrackName(tracks, 'video')).toBe('Video 8');
    expect(nextTrackName(tracks, 'audio')).toBe('Audio 1');
  });

  it('a clip placed on a new track lands in the right group', () => {
    const music = asset('audio', 'media://music');
    const film = asset('video', 'media://film');
    state().addAssets([music, film]);
    state().placeAssets([music, film], [
      { assetId: music.id, trackId: null, trackType: 'audio', startFrame: 0, durationFrames: 30 },
      { assetId: film.id, trackId: null, trackType: 'video', startFrame: 0, durationFrames: 30 },
    ]);
    expect(rowNames()).toEqual(['Video 3', 'Video 2', 'Video 1', 'Audio 1', 'Audio 2']);
  });
});

/*
  "Video 1, 2 and 3 do not layer as they should": the stacking was right, the
  names were not. Measured in the running app before this: a track added
  above Video 1 was called Video 3 and sat under Video 2, so the picture on
  "Video 3" was hidden by the one on "Video 2"; after a move and a delete the
  rows read Video 5, Video 1, Video 4, Video 3.
*/
describe('track names count by layer', () => {
  const pictureNamesTopFirst = () => timelineRows(state().project.tracks).filter((t) => t.type === 'video').map((t) => t.name);
  const drawnBottomFirst = (project = state().project) => {
    const byId = new Map(project.tracks.map((track) => [track.id, track.name]));
    const clips = project.tracks
      .filter((track) => track.type === 'video')
      .map((track) => createClip({ trackId: track.id, name: byId.get(track.id) ?? '', sourceUri: `media://${track.id}`, startFrame: 0, durationFrames: 30 }));
    return Compositor.visibleClips({ ...project, clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])) }, 10).map((clip) => clip.name);
  };

  it('a track added above Video 1 is Video 2, and the old Video 2 becomes Video 3', () => {
    const rows = timelineRows(state().project.tracks);
    const oldTop = rows[0].id;
    state().addTrackAt('video', rows.findIndex((track) => track.name === 'Video 1'));
    expect(pictureNamesTopFirst()).toEqual(['Video 3', 'Video 2', 'Video 1']);
    expect(state().project.tracks.find((track) => track.id === oldTop)?.name).toBe('Video 3');
  });

  it('whatever is done to the tracks, the compositor draws Video 1, 2, 3... bottom to top', () => {
    state().addTrack('video');
    state().addTrackAt('video', 2);
    const rows = timelineRows(state().project.tracks);
    state().moveTrack(rows[3].id, -1);
    state().moveTrack(rows[0].id, 1);
    state().removeTrack(timelineRows(state().project.tracks)[1].id);
    state().addTrack('video');
    expect(pictureNamesTopFirst()).toEqual(['Video 4', 'Video 3', 'Video 2', 'Video 1']);
    expect(drawnBottomFirst()).toEqual(['Video 1', 'Video 2', 'Video 3', 'Video 4']);
  });

  it('undo and redo bring back names that agree with the layers', () => {
    state().addTrack('video');
    const top = timelineRows(state().project.tracks)[0];
    state().moveTrack(top.id, 1);
    state().undo();
    expect(pictureNamesTopFirst()).toEqual(['Video 3', 'Video 2', 'Video 1']);
    state().redo();
    expect(pictureNamesTopFirst()).toEqual(['Video 3', 'Video 2', 'Video 1']);
    expect(drawnBottomFirst()).toEqual(['Video 1', 'Video 2', 'Video 3']);
  });

  it('a name the user typed stays; the default ones around it still count by layer', () => {
    state().addTrack('video');
    const middle = timelineRows(state().project.tracks)[1];
    state().updateTrack(middle.id, { name: 'B-roll' });
    state().moveTrack(middle.id, 1);
    expect(pictureNamesTopFirst()).toEqual(['Video 3', 'Video 2', 'B-roll']);
  });

  it('audio counts from the track nearest the picture', () => {
    state().addTrackAt('audio', timelineRows(state().project.tracks).findIndex((track) => track.type === 'audio'));
    expect(rowNames().filter((name) => name.startsWith('Audio'))).toEqual(['Audio 1', 'Audio 2']);
  });

  it('renaming rides on the edit that caused it: one undo step, with the clips and their links untouched', () => {
    const rows = timelineRows(state().project.tracks);
    const v1 = rows.find((track) => track.name === 'Video 1')!;
    const a1 = rows.find((track) => track.name === 'Audio 1')!;
    const picture = state().addClip({ trackId: v1.id, name: 'film', sourceUri: 'media://film', startFrame: 0, durationFrames: 30 });
    const sound = state().addClip({ trackId: a1.id, name: 'film', sourceUri: 'media://film', startFrame: 0, durationFrames: 30 });
    state().selectClips([picture, sound]);
    state().linkSelection();
    const linkGroup = state().project.clips[picture].linkGroup;
    expect(linkGroup).toBeDefined();
    useHistoryStore.getState().clear();

    state().addTrackAt('video', timelineRows(state().project.tracks).findIndex((track) => track.id === v1.id));
    expect(pictureNamesTopFirst()).toEqual(['Video 3', 'Video 2', 'Video 1']);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    const { clips } = state().project;
    expect([clips[picture].trackId, clips[sound].trackId]).toEqual([v1.id, a1.id]);
    expect([clips[picture].linkGroup, clips[sound].linkGroup]).toEqual([linkGroup, linkGroup]);

    state().undo();
    expect(pictureNamesTopFirst()).toEqual(['Video 2', 'Video 1']);
    expect(state().project.tracks.find((track) => track.id === v1.id)?.name).toBe('Video 1');
  });

  it('a captions track on top leaves the picture tracks counting from the bottom, and keeps its own name', () => {
    state().addTrackAt('captions');
    state().addTrackAt('video', timelineRows(state().project.tracks).findIndex((track) => track.name === 'Video 1'));
    const rows = timelineRows(state().project.tracks);
    expect(rows.map((track) => track.name)).toEqual(['Captions 1', 'Video 3', 'Video 2', 'Video 1', 'Audio 1']);
  });

  it("opening a project renames only default names: the user's own stay, Spanish ones stay Spanish", () => {
    const tracks = [
      createTrack('video', 0, 'Vídeo 3'),
      createTrack('video', 1, 'Interview'),
      createTrack('video', 2, 'Video 1'),
      createTrack('captions', 3, 'Captions 2'),
      createTrack('audio', 4, 'Music'),
      createTrack('audio', 5, 'Audio 1'),
    ];
    state().loadDocument({ version: 1, savedAt: '', project: { ...state().project, tracks, clips: {} }, assets: [], bins: [] });
    const opened = state().project;
    expect(opened.tracks.map((track) => track.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(opened.tracks.map((track) => track.name)).toEqual(['Vídeo 1', 'Interview', 'Video 3', 'Captions 2', 'Music', 'Audio 2']);
  });

  it('a project saved with scrambled names opens with names that match its stacking', () => {
    const tracks = [
      createTrack('video', 0, 'Video 1'),
      createTrack('video', 1, 'Video 3'),
      createTrack('video', 2, 'Video 2'),
      createTrack('audio', 3, 'Audio 1'),
    ];
    const project = { ...state().project, tracks, clips: {} };
    state().loadDocument({ version: 1, savedAt: '', project, assets: [], bins: [] });
    const opened = state().project;
    // Same tracks, same stacking: only the names moved.
    expect(opened.tracks.map((track) => track.order)).toEqual([0, 1, 2, 3]);
    expect(opened.tracks.map((track) => track.name)).toEqual(['Video 1', 'Video 2', 'Video 3', 'Audio 1']);
  });
});

describe('what goes on which track', () => {
  it('sound on audio tracks, pictures on picture tracks', () => {
    const video = createTrack('video', 0);
    const audio = createTrack('audio', 1);
    expect(trackAccepts(audio, 'audio')).toBe(true);
    expect(trackAccepts(video, 'audio')).toBe(false);
    expect(trackAccepts(video, 'video')).toBe(true);
    expect(trackAccepts(video, 'image')).toBe(true);
    expect(trackAccepts(audio, 'image')).toBe(false);
  });

  it('dragging an audio clip onto a video track only moves it in time', () => {
    const music = asset('audio', 'media://music');
    state().addAssets([music]);
    const [audioTrack] = state().project.tracks.filter((t) => t.type === 'audio');
    const [videoTrack] = state().project.tracks.filter((t) => t.type === 'video');
    const clip = createClip({ trackId: audioTrack.id, name: 'm', sourceUri: music.uri, startFrame: 0, durationFrames: 30 });
    state().transact('seed', (project) => ({ ...project, clips: { [clip.id]: clip } }));

    state().moveClipTo(clip.id, videoTrack.id, 40);
    const moved = state().project.clips[clip.id];
    expect(moved.trackId).toBe(audioTrack.id);
    expect(moved.startFrame).toBe(40);
  });

  it('moves a video between video tracks', () => {
    const film = asset('video', 'media://film');
    state().addAssets([film]);
    const [top, bottom] = timelineRows(state().project.tracks);
    const clip = createClip({ trackId: bottom.id, name: 'f', sourceUri: film.uri, startFrame: 0, durationFrames: 30 });
    state().transact('seed', (project) => ({ ...project, clips: { [clip.id]: clip } }));

    state().moveClipTo(clip.id, top.id, 0);
    expect(state().project.clips[clip.id].trackId).toBe(top.id);
  });
});
