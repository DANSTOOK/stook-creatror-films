import { describe, expect, it } from 'vitest';
import { contrastOf } from '@shared/utils/contrast';
import { GAIN_LINE, GAIN_SHADE, GAIN_TOP, SOUND_STRIP, WAVE_FILL } from '@renderer/components/Timeline/TimelineCanvas';

/**
 * The gain curve drawn across a clip in the timeline.
 *
 * It is the one piece of the interface that has to read on top of the
 * waveform, which is itself bright - so the line alone cannot carry it, and
 * the dark line under it is not decoration. These measure both, the way
 * tests/Contrast.test.ts measures the rest of the interface. 3:1 is the bar
 * for a graphic.
 */

/** The flat colour the shade line ends up as, over the darkest thing it is drawn on. */
const SHADE_OVER_CLIP = '#0b0e12';

describe('the gain curve over a waveform', () => {
  it('does not read on the wave by itself, which is why there is a line under it', () => {
    // Measured: 1.16:1 to 1.41:1 on the five wave colours, nowhere near the
    // 3:1 a graphic needs. Drawn alone it would be a ghost on a loud passage.
    for (const wave of Object.values(WAVE_FILL)) {
      const ratio = contrastOf(GAIN_LINE, wave);
      expect(ratio).not.toBeNull();
      expect(ratio as number).toBeLessThan(1.5);
    }
  });

  it('reads on the dark line that goes under it', () => {
    // 18.5:1.
    const ratio = contrastOf(GAIN_LINE, SHADE_OVER_CLIP);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(15);
  });

  it('the shade is dark and mostly opaque, so it covers the wave it sits on', () => {
    const alpha = Number(/,\s*([\d.]+)\s*\)$/.exec(GAIN_SHADE)?.[1]);
    expect(alpha).toBeGreaterThan(0.6);
    // Darker than the strip a video clip's sound is drawn on.
    expect(Number(/,\s*([\d.]+)\s*\)$/.exec(SOUND_STRIP)?.[1])).toBeLessThan(alpha);
  });

  it('unity gain sits in the middle of the band, where every editor puts it', () => {
    // The band runs 0 at the floor to GAIN_TOP at the ceiling, so a clip at
    // its plain volume of 1 draws a line exactly half way up.
    expect(GAIN_TOP).toBe(2);
    expect(1 / GAIN_TOP).toBe(0.5);
  });
});
