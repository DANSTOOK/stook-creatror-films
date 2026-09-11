import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { matchPreset, resolutionPresets } from '@shared/utils/resolution';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import { extensionFor, sanitizeFileName } from '@main/ipc/fileSystem';
import { isAudioClip } from '@renderer/components/Inspector/Inspector';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * Export options: resolution presets, the typed file name, the cover image;
 * and which inspector an audio clip gets.
 */

describe('resolutionPresets', () => {
  it('lists 720p, 1080p, 2K and 4K for a 16:9 project, landscape', () => {
    const sizes = resolutionPresets(1920, 1080).map((p) => `${p.width}x${p.height}`);
    expect(sizes).toEqual(['1920x1080', '1280x720', '1920x1080', '2560x1440', '3840x2160']);
  });

  it('keeps a vertical project vertical: 1080p is 1080x1920, not 1920x1080', () => {
    const p1080 = resolutionPresets(1080, 1920).find((p) => p.id === '1080p');
    expect(p1080).toMatchObject({ width: 1080, height: 1920 });
  });

  it('only ever produces even sizes, which yuv420p requires', () => {
    for (const preset of resolutionPresets(1283, 719)) {
      expect(preset.width % 2).toBe(0);
      expect(preset.height % 2).toBe(0);
    }
  });

  it('recognises a size that matches a preset, and a custom one', () => {
    const presets = resolutionPresets(1920, 1080);
    expect(matchPreset(presets, 3840, 2160)?.id).toBe('2160p');
    expect(matchPreset(presets, 1000, 500)).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFileName('Mi video final')).toBe('Mi video final');
  });

  it('cannot climb out of the chosen folder', () => {
    expect(sanitizeFileName('..\\..\\Windows\\evil')).not.toMatch(/[\\/]/);
    expect(sanitizeFileName('a/b')).toBe('a_b');
  });

  it('replaces the characters Windows forbids', () => {
    expect(sanitizeFileName('clip: take 2? <final>')).toBe('clip_ take 2_ _final_');
  });

  it('drops a typed extension, because the format decides it', () => {
    expect(sanitizeFileName('holiday.mp4')).toBe('holiday');
  });

  it('removes trailing dots and spaces, which Windows strips silently', () => {
    expect(sanitizeFileName('name. . ')).toBe('name');
  });

  it('refuses the reserved device names Windows cannot create', () => {
    expect(sanitizeFileName('CON')).toBe('CON_');
    expect(sanitizeFileName('nul')).toBe('nul_');
  });

  it('picks the extension from the format', () => {
    expect(extensionFor('mp4-h264')).toBe('mp4');
    expect(extensionFor('prores4444')).toBe('mov');
    expect(extensionFor('webm-vp9')).toBe('webm');
  });
});

describe('cover art', () => {
  it('is offered for MP4 and MOV, not for WebM or PNG sequences', () => {
    expect(EncoderPipeline.supportsCoverArt('mp4-h264')).toBe(true);
    expect(EncoderPipeline.supportsCoverArt('prores4444')).toBe(true);
    expect(EncoderPipeline.supportsCoverArt('webm-vp9')).toBe(false);
    expect(EncoderPipeline.supportsCoverArt('png-sequence')).toBe(false);
  });

  it('copies the film untouched and only encodes the image, marked as the cover', () => {
    const args = EncoderPipeline.coverArtArgs('in.mp4', 'thumb.png', 'out.mp4');
    const at = (flag: string): string => args[args.indexOf(flag) + 1];

    expect(at('-c')).toBe('copy');
    expect(at('-c:v:1')).toBe('mjpeg');
    expect(at('-disposition:v:1')).toBe('attached_pic');
    // Every stream of the film, plus the image.
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
  });
});

describe('isAudioClip', () => {
  const project = createEmptyProject();
  const [video, , audio] = project.tracks;
  const asset = (kind: MediaAsset['kind']): MediaAsset => ({
    id: kind, name: `x.${kind}`, uri: `blob:${kind}`, kind, durationFrames: 30, width: 0, height: 0, hasAlphaChannel: false,
  });
  const clip = (trackId: string, uri: string) =>
    createClip({ trackId, name: 'c', sourceUri: uri, startFrame: 0, durationFrames: 30 });

  it('treats anything on an audio track as audio', () => {
    expect(isAudioClip(clip(audio.id, 'blob:video'), project, [asset('video')])).toBe(true);
  });

  it('treats an audio file as audio wherever it sits', () => {
    expect(isAudioClip(clip(video.id, 'blob:audio'), project, [asset('audio')])).toBe(true);
  });

  it('gives video and stills the full inspector', () => {
    expect(isAudioClip(clip(video.id, 'blob:video'), project, [asset('video')])).toBe(false);
    expect(isAudioClip(clip(video.id, 'blob:image'), project, [asset('image')])).toBe(false);
  });
});
