import { describe, expect, it } from 'vitest';
import type { ExportSettings } from '@shared/types';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';

/**
 * Frame timestamps on the WebCodecs path.
 *
 * The encoded frames reach ffmpeg as a bare Annex-B stream, which has no
 * timestamps, so ffmpeg makes them up - and its made-up ones run fast: in an
 * hour-long export, durations alternated 40000/39999 ticks and the last frame
 * landed 36 ms early, more than a frame ahead of the sound. The mux now stamps
 * every packet from its index. The measurement is in the stress test; this
 * pins the arguments that do it.
 */

const settings = (patch: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  format: 'mp4-h264',
  outputPath: 'C:/out/film.mp4',
  width: 1280,
  height: 720,
  fps: 30,
  pipeMode: 'annexb-h264',
  ...patch,
});

const settsOf = (args: string[]): string | undefined => {
  const at = args.indexOf('-bsf:v');
  return at >= 0 ? args[at + 1] : undefined;
};

describe('EncoderPipeline.buildArgs - WebCodecs timestamps', () => {
  it('stamps frame N at exactly N/fps on the H.264 path', () => {
    expect(settsOf(EncoderPipeline.buildArgs(settings({})))).toBe('setts=ts=N/(30*TB)');
  });

  it('uses the project rate, fractional ones included', () => {
    expect(settsOf(EncoderPipeline.buildArgs(settings({ fps: 29.97 })))).toBe('setts=ts=N/(29.97*TB)');
    expect(settsOf(EncoderPipeline.buildArgs(settings({ fps: 60, pipeMode: 'annexb-hevc', format: 'mp4-h265' })))).toBe(
      'setts=ts=N/(60*TB)',
    );
  });

  it('applies to the copied video, after the codec choice', () => {
    const args = EncoderPipeline.buildArgs(settings({}));
    expect(args.indexOf('-bsf:v')).toBeGreaterThan(args.indexOf('copy'));
  });

  it('leaves the raw pipe alone: x264 is given frames and a rate, and times them itself', () => {
    expect(settsOf(EncoderPipeline.buildArgs(settings({ pipeMode: 'rawvideo' })))).toBeUndefined();
  });
});
