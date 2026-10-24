import { describe, expect, it } from 'vitest';

import { aspectOf, frameForAspect, isAspectId } from '@renderer/components/PreviewViewport/aspect';

/**
 * The shapes under the viewer: which one a frame is, and the frame each one
 * makes from it - the short side kept, so the picture stays as sharp.
 */

describe('which shape a frame is', () => {
  it('names the four the viewer offers', () => {
    expect(aspectOf(1920, 1080)).toBe('16:9');
    expect(aspectOf(1080, 1920)).toBe('9:16');
    expect(aspectOf(1080, 1080)).toBe('1:1');
    expect(aspectOf(1080, 1350)).toBe('4:5');
  });

  it('takes a frame a pixel or two off its shape as that shape', () => {
    expect(aspectOf(1366, 768)).toBe('16:9');
    expect(aspectOf(2560, 1440)).toBe('16:9');
  });

  it('says nothing for any other shape, or for no frame at all', () => {
    expect(aspectOf(1440, 1080)).toBeNull();
    expect(aspectOf(2560, 1080)).toBeNull();
    expect(aspectOf(0, 1080)).toBeNull();
    expect(aspectOf(Number.NaN, 1080)).toBeNull();
  });

  it('knows its own names', () => {
    expect(isAspectId('9:16')).toBe(true);
    expect(isAspectId('4:3')).toBe(false);
  });
});

describe('the frame each shape makes', () => {
  it('keeps a 1080p edit 1080 across, in every shape', () => {
    expect(frameForAspect(1920, 1080, '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(frameForAspect(1920, 1080, '1:1')).toEqual({ width: 1080, height: 1080 });
    expect(frameForAspect(1920, 1080, '4:5')).toEqual({ width: 1080, height: 1350 });
    expect(frameForAspect(1080, 1920, '16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps a 4K edit at 4K', () => {
    expect(frameForAspect(3840, 2160, '9:16')).toEqual({ width: 2160, height: 3840 });
    expect(frameForAspect(3840, 2160, '4:5')).toEqual({ width: 2160, height: 2700 });
  });

  it('gives even sides, which video encoders need', () => {
    const frame = frameForAspect(1366, 769, '16:9');
    expect(frame.width % 2).toBe(0);
    expect(frame.height % 2).toBe(0);
  });

  it('leaves a frame already of that shape as it is', () => {
    expect(frameForAspect(1920, 1080, '16:9')).toEqual({ width: 1920, height: 1080 });
  });
});
