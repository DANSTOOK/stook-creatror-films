import { describe, expect, it } from 'vitest';

import {
  SHAPE_CONTRAST,
  TEXT_CONTRAST,
  contrastOf,
  contrastRatio,
  over,
  parseColor,
  relativeLuminance,
} from '@shared/utils/contrast';

describe('reading colours the way a browser reports them', () => {
  it('reads hex, short hex, rgb and rgba', () => {
    expect(parseColor('#fff')?.rgb).toEqual([255, 255, 255]);
    expect(parseColor('#131722')?.rgb).toEqual([19, 23, 34]);
    expect(parseColor('rgb(148, 163, 184)')?.rgb).toEqual([148, 163, 184]);
    expect(parseColor('rgba(96, 165, 250, 0.5)')).toEqual({ rgb: [96, 165, 250], alpha: 0.5 });
    expect(parseColor('rgb(96 165 250 / 0.25)')?.alpha).toBe(0.25);
  });

  it('gives up on anything it does not understand, rather than guessing', () => {
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('var(--whatever)')).toBeNull();
  });
});

describe('the WCAG numbers', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([19, 23, 34], [19, 23, 34])).toBeCloseTo(1, 5);
  });

  it('does not care which way round the two are given', () => {
    expect(contrastOf('#e2e8f0', '#131722')).toBeCloseTo(contrastOf('#131722', '#e2e8f0') ?? 0, 5);
  });

  it('lays a translucent colour over what is behind it', () => {
    expect(over([255, 255, 255], 0.5, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    // Half-opaque white on a dark panel reads as the grey it looks like.
    expect(contrastOf('rgba(255, 255, 255, 0.5)', '#0d0f14')).toBeCloseTo(
      contrastRatio(over([255, 255, 255], 0.5, [13, 15, 20]), [13, 15, 20]),
      5,
    );
  });

  it('matches the published luminance of a known colour', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });
});

describe('the palette this app is built from', () => {
  const panels = ['#0d0f14', '#131722', '#1a1f2e', '#232a3d'];

  it('reads text at 4.5:1 or better on every panel', () => {
    // The three the interface uses: primary, secondary and the quiet one
    // under a field. The quiet one used to be slate-500, which is 3.0:1 on
    // the lightest panel - under the line, and it is the text that explains
    // what a control does.
    for (const colour of ['#e2e8f0', '#cbd5e1', '#94a3b8']) {
      for (const panel of panels) {
        expect(contrastOf(colour, panel) ?? 0).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      }
    }
  });

  it('draws a clip so it stands out from the timeline behind it', () => {
    // 1.4.11: a clip is a meaningful shape, so 3:1 against its background.
    for (const track of ['#456698', '#2f6f5b', '#82548e', '#8a6a2f']) {
      expect(contrastOf(track, '#131722') ?? 0).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
    }
  });

  it('marks the selected clip with a ring that can be seen on any of them', () => {
    for (const track of ['#456698', '#2f6f5b', '#82548e', '#8a6a2f']) {
      expect(contrastOf('#dbeafe', track) ?? 0).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
    }
  });

  it('shows the focus ring against every panel', () => {
    for (const panel of panels) {
      expect(contrastOf('#60a5fa', panel) ?? 0).toBeGreaterThanOrEqual(SHAPE_CONTRAST);
    }
  });
});
