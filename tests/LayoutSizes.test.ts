import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  MIN_PREVIEW_HEIGHT,
  MIN_PREVIEW_WIDTH,
  clampLayout,
  parseLayout,
  resizePanel,
} from '../src/renderer/layout/layoutSizes';

const roomy = { width: 1400, height: 900 };

describe('panel layout', () => {
  it('keeps the defaults when they fit', () => {
    expect(clampLayout(DEFAULT_LAYOUT, roomy)).toEqual(DEFAULT_LAYOUT);
  });

  it('grows and shrinks one panel within its limits', () => {
    expect(resizePanel(DEFAULT_LAYOUT, 'mediaWidth', 100, roomy).mediaWidth).toBe(360);
    expect(resizePanel(DEFAULT_LAYOUT, 'mediaWidth', -1000, roomy).mediaWidth).toBe(LAYOUT_LIMITS.mediaWidth.min);
    expect(resizePanel(DEFAULT_LAYOUT, 'inspectorWidth', 40, roomy).inspectorWidth).toBe(340);
    expect(resizePanel(DEFAULT_LAYOUT, 'timelineHeight', -1000, roomy).timelineHeight).toBe(
      LAYOUT_LIMITS.timelineHeight.min,
    );
  });

  it('never squeezes the preview below its working size', () => {
    const wide = resizePanel(DEFAULT_LAYOUT, 'mediaWidth', 5000, { width: 1000, height: 900 });
    expect(1000 - wide.mediaWidth - wide.inspectorWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
    // Widening the media panel does not steal from the inspector.
    expect(wide.inspectorWidth).toBe(DEFAULT_LAYOUT.inspectorWidth);

    const tall = resizePanel(DEFAULT_LAYOUT, 'timelineHeight', 5000, { width: 1400, height: 700 });
    expect(tall.timelineHeight).toBe(700 - MIN_PREVIEW_HEIGHT);
  });

  it('lets the minimums win in a window too small for everything', () => {
    expect(clampLayout(DEFAULT_LAYOUT, { width: 800, height: 300 })).toEqual({
      mediaWidth: LAYOUT_LIMITS.mediaWidth.min,
      inspectorWidth: 280,
      timelineHeight: LAYOUT_LIMITS.timelineHeight.min,
    });
  });

  it('applies only the fixed limits before the space is measured', () => {
    expect(resizePanel(DEFAULT_LAYOUT, 'mediaWidth', 5000, { width: 0, height: 0 }).mediaWidth).toBe(
      LAYOUT_LIMITS.mediaWidth.max,
    );
  });

  it('reads a stored layout field by field and ignores anything malformed', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('not json')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ mediaWidth: 420, inspectorWidth: 'wide', timelineHeight: 99999 }))).toEqual({
      mediaWidth: 420,
      inspectorWidth: DEFAULT_LAYOUT.inspectorWidth,
      timelineHeight: LAYOUT_LIMITS.timelineHeight.max,
    });
    const stored = { mediaWidth: 333, inspectorWidth: 280, timelineHeight: 410 };
    expect(parseLayout(JSON.stringify(stored))).toEqual(stored);
  });
});
