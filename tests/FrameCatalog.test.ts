import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { FRAMES, FRAME_GROUPS, frameById } from '@renderer/frames/catalog';

/**
 * The frame catalog: sixteen frames in three groups, each named in both
 * languages. That a frame leaves the middle of the picture CLEAR is judged in
 * the running app (tests/ui/frames.mjs), where there are pixels to read.
 */

describe('the frame catalog', () => {
  it('has sixteen frames, each its own id', () => {
    expect(FRAMES).toHaveLength(16);
    expect(new Set(FRAMES.map((frame) => frame.id)).size).toBe(FRAMES.length);
    expect(frameById('safeShorts')?.group).toBe('safe');
    expect(frameById('vignette')?.group).toBe('vignettes');
  });

  it('puts every frame in a group the panel shows, four or more to each group', () => {
    for (const frame of FRAMES) expect(FRAME_GROUPS).toContain(frame.group);
    for (const group of FRAME_GROUPS) expect(FRAMES.filter((frame) => frame.group === group).length).toBeGreaterThanOrEqual(4);
  });

  it('names each in both languages', () => {
    for (const frame of FRAMES) {
      expect(en[frame.label], frame.id).toBeTruthy();
      expect(es[frame.label], frame.id).toBeTruthy();
    }
  });

  it('keeps every id its own once it is folded into a file name', () => {
    // Kept as `frame-<id>-<width>x<height>.png`, and the main process lowercases
    // the name and drops all but a-z, 0-9 and a dash. Two ids that folded alike
    // would be one file, and one frame would quietly show another.
    const folded = FRAMES.map((frame) => `frame-${frame.id}`.toLowerCase().replace(/[^a-z0-9-]/g, ''));
    expect(new Set(folded).size).toBe(FRAMES.length);
  });

  it('does not share a file name with a background', async () => {
    // Backgrounds are kept in the same folder, under `bg-<id>-...`, so the two
    // prefixes are what keeps them apart.
    const { BACKGROUNDS } = await import('@renderer/backgrounds/catalog');
    const names = [
      ...FRAMES.map((frame) => `frame-${frame.id}`.toLowerCase()),
      ...BACKGROUNDS.map((background) => `bg-${background.id}`.toLowerCase()),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it('draws every frame', () => {
    for (const frame of FRAMES) expect(typeof frame.draw, frame.id).toBe('function');
  });
});
