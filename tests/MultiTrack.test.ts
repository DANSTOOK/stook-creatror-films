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
