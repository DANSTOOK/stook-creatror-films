import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { parseFfmpegBanner } from '@main/ipc/fileSystem';
import { snapFrameRate } from '@shared/utils/frameRate';
import { settingsFromAsset } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Frame-rate handling.
 *
 * Getting this wrong is invisible until it is not: a 60 fps clip dropped into a
 * 30 fps project exports at half the frame rate and simply looks worse, with
 * nothing anywhere reporting a problem.
 */

const BANNER_30FPS = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:00:04.03, start: 0.000000, bitrate: 45 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 43 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
`;

const BANNER_5994 = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'fast.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 7900 kb/s, 59.94 fps, 59.94 tbr, 60k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
`;

const BANNER_ALPHA = `
Input #0, matroska,webm, from 'sprite.webm':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 120 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuva420p(tv, progressive), 512x512, SAR 1:1 DAR 1:1, 25 fps, 25 tbr, 1k tbn (default)
`;

/**
 * A real WhatsApp recording. Variable frame rate, so ffmpeg reports the average
 * as "fps" and the nominal rate as "tbr". Taking 29.99 literally produced a
 * project no MP4 could represent: 180 frames muxed to a 6.21s file instead of
 * 6.00s, running 3.5% slow.
 */
const BANNER_VFR_PHONE = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'WhatsApp Video.mp4':
  Duration: 00:00:43.50, start: 0.000000, bitrate: 1537 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 474x850, 1379 kb/s, 29.99 fps, 30 tbr, 90k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 156 kb/s (default)
`;

describe('parseFfmpegBanner', () => {
  it('resolves a variable-rate average to the rate the footage really is', () => {
    const probe = parseFfmpegBanner(BANNER_VFR_PHONE, 'WhatsApp Video.mp4');

    expect(probe.fps).toBe(30);
    expect(probe.width).toBe(474);
    expect(probe.height).toBe(850);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSeconds).toBeCloseTo(43.5, 1);
  });

  it('reads resolution, codec, duration and frame rate', () => {
    const probe = parseFfmpegBanner(BANNER_30FPS, 'clip.mp4');

    expect(probe.width).toBe(640);
    expect(probe.height).toBe(360);
    expect(probe.codec).toBe('h264');
    expect(probe.fps).toBe(30);
    expect(probe.durationSeconds).toBeCloseTo(4.03, 2);
    expect(probe.hasAudio).toBe(false);
  });

  it('reads fractional broadcast rates rather than rounding them', () => {
    const probe = parseFfmpegBanner(BANNER_5994, 'fast.mp4');

    expect(probe.fps).toBeCloseTo(59.94, 2);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.durationSeconds).toBeCloseTo(62.5, 2);
  });

  it('detects an audio stream', () => {
    expect(parseFfmpegBanner(BANNER_5994, 'fast.mp4').hasAudio).toBe(true);
  });

  it('detects an alpha-bearing pixel format', () => {
    const probe = parseFfmpegBanner(BANNER_ALPHA, 'sprite.webm');

    expect(probe.hasAlphaChannel).toBe(true);
    expect(probe.fps).toBe(25);
    expect(probe.codec).toBe('vp9');
  });

  it('does not claim alpha for an opaque pixel format', () => {
    expect(parseFfmpegBanner(BANNER_30FPS, 'clip.mp4').hasAlphaChannel).toBe(false);
  });

  it('degrades to safe defaults on unparseable output', () => {
    const probe = parseFfmpegBanner('nothing useful here', 'x.mp4');

    expect(probe.fps).toBe(30);
    expect(probe.width).toBe(0);
    expect(probe.durationSeconds).toBe(0);
  });
});

describe('snapFrameRate', () => {
  it('snaps a noisy measurement onto the standard rate', () => {
    expect(snapFrameRate(29.9994)).toBe(30);
    expect(snapFrameRate(23.98)).toBe(23.976);
    expect(snapFrameRate(59.1)).toBe(59.94);
    expect(snapFrameRate(24.9)).toBe(25);
  });

  it('keeps a genuinely unusual rate rather than forcing it', () => {
    // 40 fps is more than 4% from any standard rate, so it survives intact.
    expect(snapFrameRate(40)).toBe(40);
  });

  it('rejects nonsense', () => {
    expect(snapFrameRate(0)).toBe(0);
    expect(snapFrameRate(-5)).toBe(0);
    expect(snapFrameRate(Number.NaN)).toBe(0);
  });
});

describe('settingsFromAsset', () => {
  const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
    id: 'a',
    name: 'clip.mp4',
    uri: 'blob:a',
    kind: 'video',
    durationFrames: 90,
    width: 1920,
    height: 1080,
    hasAlphaChannel: false,
    sourceFps: 59.94,
    ...overrides,
  });

  it('proposes the source rate and resolution', () => {
    expect(settingsFromAsset(asset())).toEqual({ fps: 59.94, width: 1920, height: 1080 });
  });

  it('ignores audio, which implies no picture settings', () => {
    expect(settingsFromAsset(asset({ kind: 'audio' }))).toBeNull();
  });

  it('ignores a still, whose size is the camera\'s business and not the sequence\'s', () => {
    // A screenshot dragged in first used to make the whole project 890x422.
    expect(settingsFromAsset(asset({ kind: 'image', width: 890, height: 422, sourceFps: undefined })))
      .toBeNull();
    // Even one that claims a rate: a picture does not have one.
    expect(settingsFromAsset(asset({ kind: 'image' }))).toBeNull();
  });

  it('omits what it does not know', () => {
    expect(settingsFromAsset(asset({ sourceFps: undefined }))).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(settingsFromAsset(asset({ width: 0, height: 0 }))).toEqual({ fps: 59.94 });
  });
});

describe('adopting settings on first import', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject();
  });

  const state = () => useProjectStore.getState();

  it('takes frame rate and resolution from the first clip in', () => {
    expect(state().project.fps).toBe(30);

    state().addAssets([
      {
        id: 'a',
        name: 'sixty.mp4',
        uri: 'blob:a',
        kind: 'video',
        durationFrames: 120,
        width: 3840,
        height: 2160,
        hasAlphaChannel: false,
        sourceFps: 60,
      },
    ]);

    expect(state().project.fps).toBe(60);
    expect(state().project.width).toBe(3840);
    expect(state().project.height).toBe(2160);
    expect(state().adoptedSettingsFrom).toBe('sixty.mp4');
  });

  it('rescales the timeline length so it still covers the same seconds', () => {
    const secondsBefore = state().project.durationFrames / state().project.fps;

    state().addAssets([
      {
        id: 'a',
        name: 'sixty.mp4',
        uri: 'blob:a',
        kind: 'video',
        durationFrames: 120,
        width: 1920,
        height: 1080,
        hasAlphaChannel: false,
        sourceFps: 60,
      },
    ]);

    expect(state().project.durationFrames / state().project.fps).toBeCloseTo(secondsBefore, 3);
  });

  it('leaves an established project alone', () => {
    state().addAssets([
      {
        id: 'a',
        name: 'first.mp4',
        uri: 'blob:a',
        kind: 'video',
        durationFrames: 90,
        width: 1280,
        height: 720,
        hasAlphaChannel: false,
        sourceFps: 30,
      },
    ]);

    state().addAssets([
      {
        id: 'b',
        name: 'second.mp4',
        uri: 'blob:b',
        kind: 'video',
        durationFrames: 90,
        width: 3840,
        height: 2160,
        hasAlphaChannel: false,
        sourceFps: 60,
      },
    ]);

    // The second import must not redefine a project already built around the first.
    expect(state().project.fps).toBe(30);
    expect(state().project.width).toBe(1280);
  });

  it('keeps the export settings in step with the adopted project', () => {
    state().addAssets([
      {
        id: 'a',
        name: 'pal.mp4',
        uri: 'blob:a',
        kind: 'video',
        durationFrames: 50,
        width: 720,
        height: 576,
        hasAlphaChannel: false,
        sourceFps: 25,
      },
    ]);

    expect(state().exportSettings.fps).toBe(25);
    expect(state().exportSettings.width).toBe(720);
  });
});
