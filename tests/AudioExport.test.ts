import { describe, expect, it } from 'vitest';
import type { ExportSettings } from '@shared/types';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import { encodeWavFloat32, readWavHeader } from '@shared/utils/wav';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';

/**
 * Audio export.
 *
 * The WAV writer and the muxing arguments are the two halves that have to agree
 * for an exported file to have sound.
 */

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  outputPath: '/tmp/out.mp4',
  startFrame: 0,
  endFrame: 60,
  ...overrides,
});

const argOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe('encodeWavFloat32', () => {
  it('writes a header describing what it actually wrote', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1]);
    const right = Float32Array.from([1, -1, 0.25, 0]);

    const header = readWavHeader(encodeWavFloat32([left, right], 48000));

    expect(header.channels).toBe(2);
    expect(header.sampleRate).toBe(48000);
    expect(header.bitsPerSample).toBe(32);
    expect(header.formatTag).toBe(3); // IEEE float
    expect(header.frameCount).toBe(4);
  });

  it('interleaves the channels, because WAV is not planar', () => {
    const left = Float32Array.from([1, 2]);
    const right = Float32Array.from([10, 20]);

    const view = new DataView(encodeWavFloat32([left, right], 48000));
    const sampleAt = (index: number): number => view.getFloat32(44 + index * 4, true);

    // Expected order on disk: L0, R0, L1, R1.
    expect(sampleAt(0)).toBeCloseTo(1);
    expect(sampleAt(1)).toBeCloseTo(10);
    expect(sampleAt(2)).toBeCloseTo(2);
    expect(sampleAt(3)).toBeCloseTo(20);
  });

  it('handles mono', () => {
    const header = readWavHeader(encodeWavFloat32([Float32Array.from([0.1, 0.2, 0.3])], 44100));
    expect(header.channels).toBe(1);
    expect(header.frameCount).toBe(3);
  });

  it('pads a short channel with silence instead of truncating the mix', () => {
    const long = Float32Array.from([1, 1, 1, 1]);
    const short = Float32Array.from([1]);

    const buffer = encodeWavFloat32([long, short], 48000);
    const view = new DataView(buffer);

    expect(readWavHeader(buffer).frameCount).toBe(4);
    // Frame 3, right channel: past the end of `short`, so silence.
    expect(view.getFloat32(44 + 7 * 4, true)).toBe(0);
  });

  it('rejects nonsense rather than writing a broken file', () => {
    expect(() => encodeWavFloat32([], 48000)).toThrow();
    expect(() => encodeWavFloat32([Float32Array.from([0])], 0)).toThrow();
  });
});

describe('EncoderPipeline.buildArgs - audio muxing', () => {
  const withAudio = settings({ audioPath: '/tmp/mix.wav', audioBitrateKbps: 256 });

  it('adds the mix as a second input and maps both streams explicitly', () => {
    const args = EncoderPipeline.buildArgs({ ...withAudio, pipeMode: 'annexb-h264' });

    expect(args).toContain('/tmp/mix.wav');
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
    expect(args).toContain('0:v:0');
    expect(args).toContain('1:a:0');
    expect(argOf(args, '-c:a')).toBe('aac');
    expect(argOf(args, '-b:a')).toBe('256k');
    expect(argOf(args, '-ar')).toBe('48000');
  });

  it('never passes -shortest, which silences the WebCodecs path', () => {
    // An Annex-B stream carries no timestamps, so copied video packets reach
    // the muxer with no PTS. `-shortest` then resolves the video length as
    // nothing and writes zero bytes of audio - a file whose header declares a
    // perfectly good AAC stream that contains silence.
    for (const pipeMode of ['annexb-h264', 'annexb-hevc', 'rawvideo'] as const) {
      expect(EncoderPipeline.buildArgs({ ...withAudio, pipeMode })).not.toContain('-shortest');
    }
  });

  it('muxes audio on the raw pipe path too', () => {
    const args = EncoderPipeline.buildArgs({ ...withAudio, pipeMode: 'rawvideo' });
    expect(args).toContain('/tmp/mix.wav');
    expect(argOf(args, '-c:a')).toBe('aac');
  });

  it('keeps the video copy on the WebCodecs path while encoding audio', () => {
    const args = EncoderPipeline.buildArgs({ ...withAudio, pipeMode: 'annexb-h264' });
    expect(argOf(args, '-c:v')).toBe('copy');
    expect(argOf(args, '-c:a')).toBe('aac');
  });

  it('omits audio entirely when there is no mix', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264' }));
    expect(args).not.toContain('-map');
    expect(args).not.toContain('-c:a');
  });

  it('never attaches audio to a PNG sequence, which is a pile of stills', () => {
    const args = EncoderPipeline.buildArgs({
      ...withAudio,
      format: 'png-sequence',
      outputPath: '/tmp/frames',
    });
    expect(args).not.toContain('/tmp/mix.wav');
    expect(args).not.toContain('-c:a');
  });

  it('falls back to a sane audio bitrate when none is given', () => {
    const args = EncoderPipeline.buildArgs({
      ...settings({ audioPath: '/tmp/mix.wav' }),
      pipeMode: 'annexb-h264',
    });
    expect(argOf(args, '-b:a')).toBe('256k');
  });
});
