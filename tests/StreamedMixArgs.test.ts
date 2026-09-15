import { describe, expect, it } from 'vitest';
import type { ExportSettings } from '@shared/types';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';

/**
 * The streamed export mix reaches ffmpeg as headerless float32.
 *
 * A WAV header carries the format; a raw stream does not, so ffmpeg has to be
 * told the format, rate and channel count BEFORE the input it describes - put
 * after it, the same options would describe the output and ffmpeg would read
 * the file as whatever it guessed.
 */

const settings = (patch: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  format: 'mp4-h264',
  outputPath: 'C:/out/film.mp4',
  width: 1280,
  height: 720,
  fps: 30,
  audioPath: 'C:/tmp/filmora-mix.f32le',
  audioBitrateKbps: 256,
  ...patch,
});

describe('EncoderPipeline.buildArgs - streamed mix', () => {
  it('describes a raw mix to ffmpeg right before it is read', () => {
    const args = EncoderPipeline.buildArgs(settings({ audioRawFormat: { sampleRate: 48000, channels: 2 } }));
    const input = args.indexOf('C:/tmp/filmora-mix.f32le');
    expect(args[input - 1]).toBe('-i');
    expect(args.slice(input - 7, input - 1)).toEqual(['-f', 'f32le', '-ar', '48000', '-ac', '2']);
  });

  it('describes it on the WebCodecs path too', () => {
    const args = EncoderPipeline.buildArgs(
      settings({ pipeMode: 'annexb-h264', audioRawFormat: { sampleRate: 48000, channels: 1 } }),
    );
    const input = args.indexOf('C:/tmp/filmora-mix.f32le');
    expect(args.slice(input - 7, input)).toEqual(['-f', 'f32le', '-ar', '48000', '-ac', '1', '-i']);
    expect(args).toContain('copy');
  });

  it('still reads a WAV mix with no format options', () => {
    const args = EncoderPipeline.buildArgs(settings({ audioPath: 'C:/tmp/mix.wav', audioRawFormat: undefined }));
    expect(args).not.toContain('f32le');
    const input = args.indexOf('C:/tmp/mix.wav');
    expect(args[input - 1]).toBe('-i');
    expect(args[input - 2]).not.toBe('2');
  });

  it('describes the video pipe and the mix separately', () => {
    const args = EncoderPipeline.buildArgs(settings({ audioRawFormat: { sampleRate: 48000, channels: 2 } }));
    // The raw video pipe keeps its own format; the mix's options come after it.
    expect(args.indexOf('rawvideo')).toBeLessThan(args.indexOf('f32le'));
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2);
  });
});
