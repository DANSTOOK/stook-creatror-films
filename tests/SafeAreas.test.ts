import { describe, expect, it } from 'vitest';
import { ACTION_SAFE, safeAreaRects, safeRect } from '@renderer/components/PreviewViewport/safeAreas';
import { TITLE_SAFE } from '@renderer/text/titleStyle';

/**
 * The safe areas the viewer draws: action at 93% of the frame and title at
 * 90%, the boxes SMPTE ST 2046-1 defines and that every editor shows.
 */

describe('safeRect', () => {
  it('centres the box, so the margin is the same on both sides', () => {
    const rect = safeRect(1000, 500, 0.9);
    // Close, not equal: (1 - 0.9) / 2 is 0.05000000000000002 in binary.
    expect(rect.x).toBeCloseTo(50, 9);
    expect(rect.y).toBeCloseTo(25, 9);
    expect(rect.width).toBeCloseTo(900, 9);
    expect(rect.height).toBeCloseTo(450, 9);
    expect(rect.x).toBeCloseTo(1000 - (rect.x + rect.width), 10);
    expect(rect.y).toBeCloseTo(500 - (rect.y + rect.height), 10);
  });

  it('covers the whole frame at a share of one', () => {
    expect(safeRect(1920, 1080, 1)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});

describe('safeAreaRects', () => {
  it('puts the title box inside the action box', () => {
    const { action, title } = safeAreaRects(1920, 1080);
    expect(title.x).toBeGreaterThan(action.x);
    expect(title.y).toBeGreaterThan(action.y);
    expect(title.x + title.width).toBeLessThan(action.x + action.width);
    expect(title.y + title.height).toBeLessThan(action.y + action.height);
  });

  it('uses the same title-safe share the titles themselves are pinned to', () => {
    const { title } = safeAreaRects(1920, 1080);
    expect(title.width / 1920).toBeCloseTo(TITLE_SAFE, 10);
  });

  it('matches broadcast practice: 93% action, 90% title', () => {
    expect(ACTION_SAFE).toBe(0.93);
    const { action } = safeAreaRects(1920, 1080);
    expect(action.width).toBeCloseTo(1785.6, 4);
    expect(action.height).toBeCloseTo(1004.4, 4);
  });

  it('works for a vertical frame as well as a wide one', () => {
    const { action, title } = safeAreaRects(1080, 1920);
    expect(action.width / 1080).toBeCloseTo(ACTION_SAFE, 10);
    expect(title.height / 1920).toBeCloseTo(TITLE_SAFE, 10);
  });
});
