import { describe, expect, it } from 'vitest';
import { playableArgs } from '../src/main/media/playable';

describe('a copy of a video the decoder can open', () => {
  it('a repack moves the packets into a new box, without the edit list, changing nothing in them', () => {
    const args = playableArgs('in.mp4', 'out.mp4', 'remux');
    expect(args.indexOf('-ignore_editlist')).toBeLessThan(args.indexOf('-i'));
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', 'copy']);
    expect(args).not.toContain('libx264');
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('a conversion makes H.264 a decoder plays, keeping the sound when there is any', () => {
    const args = playableArgs('in.mov', 'out.mp4', 'transcode');
    expect(args).toContain('libx264');
    expect(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 2)).toEqual(['-pix_fmt', 'yuv420p']);
    expect(args).toContain('0:a?');
    expect(args).toContain('+faststart');
  });
});
