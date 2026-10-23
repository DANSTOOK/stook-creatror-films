import { describe, expect, it } from 'vitest';
import { audioArgs, gifArgs } from '../src/main/exporter/deliverables';

describe('files made from a render', () => {
  it('a GIF finds its own colours and loops, at the width and rate asked', () => {
    const args = gifArgs('in.mp4', 'out.gif', { fps: 15, width: 481 });
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain('fps=15');
    expect(filter).toContain('scale=482:-2');
    expect(filter).toContain('palettegen');
    expect(filter).toContain('paletteuse');
    expect(args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 2)).toEqual(['-loop', '0']);
  });

  it('the sound alone reads the raw mix as the video export writes it', () => {
    const mp3 = audioArgs('mix.f32le', { sampleRate: 48000, channels: 2 }, 'out.mp3', 'mp3');
    expect(mp3.slice(0, 12)).toContain('f32le');
    expect(mp3).toContain('libmp3lame');
    expect(audioArgs('mix.f32le', { sampleRate: 44100, channels: 1 }, 'out.wav', 'wav')).toContain('pcm_s16le');
  });
});
