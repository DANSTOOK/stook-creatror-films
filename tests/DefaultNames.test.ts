import { afterEach, describe, expect, it } from 'vitest';

import { useLanguageStore } from '@renderer/i18n';
import { createEmptyProject, createMarker, createTrack } from '@renderer/store/types';
import { nextTrackName } from '@renderer/components/Timeline/trackRows';
import { nextBinName } from '@renderer/media/bins';
import { trackNameNumber } from '@renderer/i18n/defaultNames';

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
});
