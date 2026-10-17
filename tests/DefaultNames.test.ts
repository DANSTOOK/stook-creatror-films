import { afterEach, describe, expect, it } from 'vitest';

import { useLanguageStore } from '@renderer/i18n';
import { createEmptyProject, createMarker, createTrack } from '@renderer/store/types';
import { nextTrackName, withLayerNames } from '@renderer/components/Timeline/trackRows';
import { nextBinName } from '@renderer/media/bins';
import { renumberedTrackName, trackNameNumber } from '@renderer/i18n/defaultNames';

/**
 * Names the editor gives things are in the language on screen when they are
 * made, and stay as they were made.
 */

const speak = (language: 'en' | 'es'): void => useLanguageStore.setState({ language });

afterEach(() => speak('en'));

describe('default names', () => {
  it('are English by default', () => {
    expect(createEmptyProject().tracks.map((track) => track.name)).toEqual(['Video 1', 'Video 2', 'Audio 1']);
    expect(createMarker(90).label).toBe('Marker 90');
    expect(nextBinName([], null)).toBe('Bin 1');
  });

  it('are Spanish when the editor is in Spanish', () => {
    speak('es');
    expect(createEmptyProject().tracks.map((track) => track.name)).toEqual(['Vídeo 1', 'Vídeo 2', 'Audio 1']);
    expect(createMarker(90).label).toBe('Marcador 90');
    expect(nextBinName([], null)).toBe('Carpeta 1');
    expect(nextBinName([{ id: 'a', name: 'Carpeta 1', parentId: null }], null)).toBe('Carpeta 2');
  });

  it('are not renamed when the language changes afterwards', () => {
    const project = createEmptyProject();
    speak('es');
    expect(project.tracks[0].name).toBe('Video 1');
  });

  it('count on from names made in the other language', () => {
    const tracks = [createTrack('video', 0, 'Video 1'), createTrack('video', 1, 'Video 2')];
    speak('es');
    expect(nextTrackName(tracks, 'video')).toBe('Vídeo 3');
    expect(trackNameNumber('video', 'Vídeo 7')).toBe(7);
    expect(trackNameNumber('video', 'Interview')).toBeNull();
  });

  it('renumbered by layer, a default name keeps the language it was made in', () => {
    speak('es');
    expect(renumberedTrackName('video', 'Video 3', 2)).toBe('Video 2');
    expect(renumberedTrackName('video', 'Vídeo 3', 1)).toBe('Vídeo 1');
    expect(renumberedTrackName('video', 'Interview', 1)).toBeNull();
    const tracks = withLayerNames([createTrack('video', 0, 'Vídeo 2'), createTrack('video', 1, 'Video 1')]);
    expect(tracks.map((track) => track.name)).toEqual(['Vídeo 1', 'Video 2']);
  });

  describe('counted by layer (withLayerNames)', () => {
    // Rows are listed top first; a picture track's order is its layer, 0 at the bottom.
    const names = (tracks: ReturnType<typeof createTrack>[]) => withLayerNames(tracks).map((track) => track.name);

    it("a name the user typed is never touched, and still takes its layer's place in the count", () => {
      // 'Video 7' is a default name, wherever it came from: it counts by its layer.
      expect(names([createTrack('video', 0, 'Interview'), createTrack('video', 1, 'Video 7'), createTrack('video', 2, 'Video 1')])).toEqual([
        'Interview',
        'Video 2',
        'Video 3',
      ]);
      // Only the whole pattern is a default name: a word added to it makes it the user's.
      expect(names([createTrack('video', 0, 'Video 3 final'), createTrack('video', 1, 'Video 5 (B-roll)')])).toEqual(['Video 3 final', 'Video 5 (B-roll)']);
    });

    it('Spanish default names are renumbered in Spanish, English ones in English, side by side', () => {
      speak('es');
      expect(names([createTrack('video', 0, 'Vídeo 3'), createTrack('video', 1, 'Video 1'), createTrack('audio', 2, 'Audio 4')])).toEqual([
        'Vídeo 1',
        'Video 2',
        'Audio 1',
      ]);
    });

    it('captions, text and adjustment tracks keep the names they have', () => {
      const tracks = [
        createTrack('video', 0, 'Video 2'),
        createTrack('captions', 1, 'Captions 3'),
        createTrack('captions', 2, 'Subtítulos 1'),
        createTrack('audio', 3, 'Audio 1'),
      ];
      expect(names(tracks)).toEqual(['Video 1', 'Captions 3', 'Subtítulos 1', 'Audio 1']);
    });

    it('gives back the very same tracks when every name already matches its layer', () => {
      const tracks = [createTrack('video', 0, 'Video 1'), createTrack('video', 1, 'Interview'), createTrack('audio', 2, 'Audio 1')];
      const named = withLayerNames(tracks);
      expect(named.every((track, index) => track === tracks[index])).toBe(true);
    });
  });
});
