import { describe, expect, it } from 'vitest';
import type { ExportSettings } from '@shared/types';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import {
  FORMAT_SUPPORTS_ALPHA,
  describeAlphaFallback,
  videoCodecArgs,
} from '@main/exporter/HardwareAccel';
import { isWebCodecsEligible } from '@renderer/engine/WebCodecsEncoder';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  outputPath: '/tmp/out.mp4',
  startFrame: 0,
  endFrame: 100,
  ...overrides,
});

/** Value that follows a flag, e.g. argOf(args, '-c:v'). */
const argOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe('EncoderPipeline.buildArgs - raw RGBA pipe', () => {
  it('describes the raw input so ffmpeg can interpret the pipe', () => {
    const args = EncoderPipeline.buildArgs(settings({ width: 1920, height: 1080, fps: 30 }));

    expect(argOf(args, '-f')).toBe('rawvideo');
    expect(argOf(args, '-pixel_format')).toBe('rgba');
    expect(argOf(args, '-video_size')).toBe('1920x1080');
    expect(argOf(args, '-framerate')).toBe('30');
    expect(argOf(args, '-i')).toBe('pipe:0');
  });

  it('writes a PNG sequence into a numbered pattern inside the chosen folder', () => {
    const args = EncoderPipeline.buildArgs(
      settings({ format: 'png-sequence', outputPath: '/tmp/sprites' }),
    );

    expect(args[args.length - 1]).toMatch(/frame_%05d\.png$/);
  });

  it('overwrites the output rather than prompting', () => {
    expect(EncoderPipeline.buildArgs(settings())).toContain('-y');
  });
});

describe('EncoderPipeline.buildArgs - WebCodecs elementary stream', () => {
  it('muxes without re-encoding', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264' }));

    expect(argOf(args, '-f')).toBe('h264');
    expect(argOf(args, '-c:v')).toBe('copy');
    // Re-encoding would defeat the whole point of encoding on the GPU.
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('rawvideo');
  });

  it('selects the hevc demuxer and hvc1 tag for H.265', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-hevc' }));

    expect(argOf(args, '-f')).toBe('hevc');
    expect(argOf(args, '-c:v')).toBe('copy');
    expect(argOf(args, '-tag:v')).toBe('hvc1');
  });

  it('does not describe a raw frame size, which has no meaning for a stream', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264' }));
    expect(args).not.toContain('-video_size');
    expect(args).not.toContain('-pixel_format');
  });

  it('still carries the frame rate so the muxed file has correct timing', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264', fps: 24 }));
    expect(argOf(args, '-framerate')).toBe('24');
  });
});

describe('EncoderPipeline.frameCount', () => {
  it('counts the half-open range', () => {
    expect(EncoderPipeline.frameCount(settings({ startFrame: 10, endFrame: 40 }))).toBe(30);
  });

  it('never reports a negative count', () => {
    expect(EncoderPipeline.frameCount(settings({ startFrame: 90, endFrame: 10 }))).toBe(0);
  });
});

describe('alpha capability', () => {
  it('knows which containers carry an alpha channel', () => {
    expect(FORMAT_SUPPORTS_ALPHA['png-sequence']).toBe(true);
    expect(FORMAT_SUPPORTS_ALPHA.prores4444).toBe(true);
    expect(FORMAT_SUPPORTS_ALPHA['webm-vp9']).toBe(true);
    expect(FORMAT_SUPPORTS_ALPHA['mp4-h264']).toBe(false);
    expect(FORMAT_SUPPORTS_ALPHA['mp4-h265']).toBe(false);
  });

  it('flags a request for alpha in a format that cannot store it', () => {
    expect(EncoderPipeline.willDropAlpha(settings({ format: 'mp4-h264', exportAlpha: true }))).toBe(
      true,
    );
    expect(
      EncoderPipeline.willDropAlpha(settings({ format: 'prores4444', exportAlpha: true })),
    ).toBe(false);
  });

  it('explains the fallback instead of failing silently', () => {
    expect(describeAlphaFallback(settings({ format: 'mp4-h264', exportAlpha: true }))).toMatch(
      /no alpha channel/i,
    );
    expect(describeAlphaFallback(settings({ format: 'prores4444', exportAlpha: true }))).toBeNull();
    expect(describeAlphaFallback(settings({ exportAlpha: false }))).toBeNull();
  });

  it('warns that a hardware encoder cannot carry alpha', () => {
    const message = describeAlphaFallback(
      settings({ format: 'webm-vp9', exportAlpha: true, hardwareEncoder: 'nvenc' }),
    );
    expect(message).toMatch(/software encoder/i);
  });
});

describe('videoCodecArgs', () => {
  it('keeps alpha in a ProRes 4444 render', () => {
    const args = videoCodecArgs(settings({ format: 'prores4444', exportAlpha: true }));
    expect(argOf(args, '-pix_fmt')).toBe('yuva444p10le');
    expect(argOf(args, '-profile:v')).toBe('4444');
  });

  it('disables alt-ref frames for transparent WebM, which would drop alpha', () => {
    const args = videoCodecArgs(settings({ format: 'webm-vp9', exportAlpha: true }));
    expect(argOf(args, '-pix_fmt')).toBe('yuva420p');
    expect(argOf(args, '-auto-alt-ref')).toBe('0');
  });

  it('leaves alt-ref alone for an opaque WebM', () => {
    const args = videoCodecArgs(settings({ format: 'webm-vp9', exportAlpha: false }));
    expect(argOf(args, '-pix_fmt')).toBe('yuv420p');
    expect(args).not.toContain('-auto-alt-ref');
  });

  it('uses a hardware codec when one is selected', () => {
    expect(argOf(videoCodecArgs(settings({ hardwareEncoder: 'nvenc' })), '-c:v')).toBe('h264_nvenc');
    expect(
      argOf(videoCodecArgs(settings({ format: 'mp4-h265', hardwareEncoder: 'videotoolbox' })), '-c:v'),
    ).toBe('hevc_videotoolbox');
  });

  it('falls back to a software codec when no hardware encoder is chosen', () => {
    expect(argOf(videoCodecArgs(settings({ hardwareEncoder: 'none' })), '-c:v')).toBe('libx264');
  });

  it('emits rgba for a transparent PNG sequence', () => {
    expect(
      argOf(videoCodecArgs(settings({ format: 'png-sequence', exportAlpha: true })), '-pix_fmt'),
    ).toBe('rgba');
  });
});

describe('isWebCodecsEligible', () => {
  it('accepts the opaque delivery formats', () => {
    expect(isWebCodecsEligible(settings({ format: 'mp4-h264' }))).toBe(true);
    expect(isWebCodecsEligible(settings({ format: 'mp4-h265' }))).toBe(true);
  });

  it('refuses any render that needs alpha, since no browser encoder carries it', () => {
    expect(isWebCodecsEligible(settings({ format: 'mp4-h264', exportAlpha: true }))).toBe(false);
    expect(isWebCodecsEligible(settings({ format: 'prores4444' }))).toBe(false);
    expect(isWebCodecsEligible(settings({ format: 'webm-vp9' }))).toBe(false);
    expect(isWebCodecsEligible(settings({ format: 'png-sequence' }))).toBe(false);
  });

  it('refuses pixel-art scaling, which is an ffmpeg filter', () => {
    expect(isWebCodecsEligible(settings({ format: 'mp4-h264', pixelArtScaling: true }))).toBe(false);
  });
});
