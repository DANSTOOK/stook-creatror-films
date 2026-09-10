import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { buildUriRemap, remapClipSources } from '@renderer/media/importMedia';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * Reopening a saved project.
 *
 * Regression cover for a bug the UI test found and nothing else could: media
 * was re-read from disk and given fresh blob URLs, but the clips still pointed
 * at the URLs from the previous session. The media panel looked perfectly
 * healthy - no "missing" badge anywhere - while the timeline referenced dead
 * URLs, so the picture rendered nothing and exports came out silent.
 */

const asset = (id: string, uri: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  uri,
  sourcePath: `C:/media/${id}.mp4`,
  kind: 'video',
  durationFrames: 90,
  width: 1920,
  height: 1080,
  hasAlphaChannel: false,
});

describe('buildUriRemap', () => {
  it('maps every asset from its saved URL to the fresh one', () => {
    const before = [asset('a', 'blob:old-a'), asset('b', 'blob:old-b')];
    const after = [asset('a', 'blob:new-a'), asset('b', 'blob:new-b')];

    const remap = buildUriRemap(before, after);

    expect(remap.get('blob:old-a')).toBe('blob:new-a');
    expect(remap.get('blob:old-b')).toBe('blob:new-b');
  });

  it('matches by id, not by position', () => {
    // Rehydration resolves in parallel, so order is not something to lean on.
    const before = [asset('a', 'blob:old-a'), asset('b', 'blob:old-b')];
    const after = [asset('b', 'blob:new-b'), asset('a', 'blob:new-a')];

    const remap = buildUriRemap(before, after);

    expect(remap.get('blob:old-a')).toBe('blob:new-a');
    expect(remap.get('blob:old-b')).toBe('blob:new-b');
  });

  it('skips assets whose URL did not change', () => {
    const same = [asset('a', 'blob:same')];
    expect(buildUriRemap(same, same).size).toBe(0);
  });

  it('ignores an asset that was not restored', () => {
    const remap = buildUriRemap([asset('a', 'blob:old-a')], []);
    expect(remap.size).toBe(0);
  });
});

describe('remapClipSources', () => {
  const projectWith = (sourceUri: string) => {
    const base = createEmptyProject();
    const clip = createClip({
      trackId: base.tracks[0].id,
      name: 'clip',
      sourceUri,
      startFrame: 0,
      durationFrames: 60,
    });
    return { ...base, clips: { [clip.id]: clip } };
  };

  it('points clips at the restored URL', () => {
    const project = projectWith('blob:old-a');
    const remapped = remapClipSources(project, new Map([['blob:old-a', 'blob:new-a']]));

    expect(Object.values(remapped.clips)[0].sourceUri).toBe('blob:new-a');
  });

  it('leaves a clip alone when its source is not in the map', () => {
    const project = projectWith('blob:untouched');
    const remapped = remapClipSources(project, new Map([['blob:other', 'blob:new']]));

    expect(Object.values(remapped.clips)[0].sourceUri).toBe('blob:untouched');
  });

  it('returns the project unchanged for an empty map', () => {
    const project = projectWith('blob:a');
    expect(remapClipSources(project, new Map())).toBe(project);
  });

  it('preserves everything else about the clip', () => {
    const project = projectWith('blob:old');
    const before = Object.values(project.clips)[0];

    const after = Object.values(
      remapClipSources(project, new Map([['blob:old', 'blob:new']])).clips,
    )[0];

    expect(after.id).toBe(before.id);
    expect(after.startFrame).toBe(before.startFrame);
    expect(after.durationFrames).toBe(before.durationFrames);
    expect(after.trackId).toBe(before.trackId);
  });
});
