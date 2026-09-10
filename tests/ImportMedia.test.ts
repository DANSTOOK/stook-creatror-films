import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  appendPosition,
  classifyFile,
  hasNativeBridge,
  isSupportedFile,
  mimeForFile,
} from '@renderer/media/importMedia';
import { createClip, createEmptyProject } from '@renderer/store/types';

describe('classifyFile', () => {
  it('routes each family to the right kind', () => {
    expect(classifyFile('clip.mp4')).toBe('video');
    expect(classifyFile('take.mov')).toBe('video');
    expect(classifyFile('music.mp3')).toBe('audio');
    expect(classifyFile('voice.wav')).toBe('audio');
    expect(classifyFile('sprite.png')).toBe('image');
    expect(classifyFile('photo.JPEG')).toBe('image');
  });

  it('ignores case and handles dots inside the name', () => {
    expect(classifyFile('My.Holiday.Video.MP4')).toBe('video');
    expect(classifyFile('track.01.FLAC')).toBe('audio');
  });
});

describe('isSupportedFile', () => {
  it('accepts the media formats the engine can decode', () => {
    expect(isSupportedFile('a.webm')).toBe(true);
    expect(isSupportedFile('b.m4a')).toBe(true);
    expect(isSupportedFile('c.webp')).toBe(true);
  });

  it('rejects anything else, so a stray drop is reported rather than imported', () => {
    expect(isSupportedFile('notes.txt')).toBe(false);
    expect(isSupportedFile('project.fep')).toBe(false);
    expect(isSupportedFile('archive.zip')).toBe(false);
    expect(isSupportedFile('noextension')).toBe(false);
  });
});

describe('mimeForFile', () => {
  it('maps known containers to their real type', () => {
    expect(mimeForFile('a.mp4')).toBe('video/mp4');
    expect(mimeForFile('a.webm')).toBe('video/webm');
    expect(mimeForFile('a.mov')).toBe('video/quicktime');
    expect(mimeForFile('a.png')).toBe('image/png');
    expect(mimeForFile('a.m4a')).toBe('audio/mp4');
  });

  it('falls back to a wildcard within the right family', () => {
    expect(mimeForFile('a.opus')).toBe('video/*');
    expect(mimeForFile('a.aiff')).toBe('video/*');
  });
});

describe('ACCEPT_ATTRIBUTE', () => {
  it('lists dotted extensions for the file picker', () => {
    expect(ACCEPT_ATTRIBUTE).toContain('.mp4');
    expect(ACCEPT_ATTRIBUTE).toContain('.png');
    expect(ACCEPT_ATTRIBUTE.startsWith('.')).toBe(true);
    expect(ACCEPT_ATTRIBUTE).not.toContain(' ');
  });
});

describe('hasNativeBridge', () => {
  it('is false outside Electron, which is what gates the dialog path', () => {
    // The unit suite runs in Node: no window, therefore no bridge.
    expect(hasNativeBridge()).toBe(false);
  });
});

describe('appendPosition', () => {
  const project = createEmptyProject();
  const trackId = project.tracks[0].id;

  it('is zero on an empty track', () => {
    expect(appendPosition(project, trackId)).toBe(0);
  });

  it('lands immediately after the last clip on that track', () => {
    const clip = createClip({
      trackId,
      name: 'a',
      sourceUri: 'blob:a',
      startFrame: 10,
      durationFrames: 50,
    });
    const populated = { ...project, clips: { [clip.id]: clip } };

    expect(appendPosition(populated, trackId)).toBe(60);
  });

  it('ignores clips on other tracks', () => {
    const other = createClip({
      trackId: project.tracks[1].id,
      name: 'b',
      sourceUri: 'blob:b',
      startFrame: 0,
      durationFrames: 900,
    });
    const populated = { ...project, clips: { [other.id]: other } };

    expect(appendPosition(populated, trackId)).toBe(0);
  });

  it('uses the furthest end, not the last added clip', () => {
    const long = createClip({
      trackId,
      name: 'long',
      sourceUri: 'blob:l',
      startFrame: 0,
      durationFrames: 300,
    });
    const short = createClip({
      trackId,
      name: 'short',
      sourceUri: 'blob:s',
      startFrame: 5,
      durationFrames: 10,
    });
    const populated = { ...project, clips: { [long.id]: long, [short.id]: short } };

    expect(appendPosition(populated, trackId)).toBe(300);
  });
});
