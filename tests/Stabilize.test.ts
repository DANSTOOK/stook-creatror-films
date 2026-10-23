import { describe, expect, it } from 'vitest';
import { STABILIZE, stabilizeArgs, statsSeconds } from '../src/main/media/stabilize';

describe('stabilizing a video', () => {
  it('smooths more, and looks for more shake, the stronger it is', () => {
    expect(STABILIZE.light.smoothing).toBeLessThan(STABILIZE.medium.smoothing);
    expect(STABILIZE.medium.smoothing).toBeLessThan(STABILIZE.strong.smoothing);
  });

  it('follows the shake, then steadies it, zoomed just enough, every frame where it was, the sound copied', () => {
    const { detect, transform } = stabilizeArgs('C:\\clips\\walk.mp4', 'C:\\out\\walk.mp4', 'medium', 'walk.trf');
    expect(detect.join(' ')).toContain('vidstabdetect=shakiness=6:accuracy=15:result=walk.trf');
    const filter = transform[transform.indexOf('-vf') + 1];
    expect(filter).toContain('vidstabtransform=input=walk.trf:smoothing=18:optzoom=1');
    // The transforms file is named, not a full path: C:\ would end the filter's option at the colon.
    expect(filter).not.toContain('C:');
    expect(transform[transform.indexOf('-fps_mode') + 1]).toBe('passthrough');
    expect(transform[transform.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('reads how far ffmpeg has got', () => {
    expect(statsSeconds('frame=  120 fps= 60 q=-0.0 size=N/A time=00:01:02.50 bitrate=N/A speed=2x')).toBeCloseTo(62.5);
    expect(statsSeconds('nothing here')).toBeNull();
  });
});
