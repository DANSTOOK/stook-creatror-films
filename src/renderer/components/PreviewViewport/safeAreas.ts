import { TITLE_SAFE } from '@renderer/text/titleStyle';

/**
 * The safe areas, in project pixels.
 *
 * Television sets and many players crop the edges of a frame, and phones put
 * their own furniture over them. Broadcast practice, SMPTE ST 2046-1, draws
 * two boxes: action-safe at 93% of the frame, which everything that matters
 * should stay inside, and title-safe at 90%, for text. The app already pins
 * titles to the 90% box (TITLE_SAFE); this draws both so the edit can be
 * judged against them.
 *
 * Pure: rectangles in, rectangles out, so the geometry is tested directly.
 */

/** Share of the frame each way that survives a cropping player. */
export const ACTION_SAFE = 0.93;

export interface SafeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box covering `share` of the frame, centred. */
export function safeRect(width: number, height: number, share: number): SafeRect {
  const inset = (1 - share) / 2;
  return {
    x: width * inset,
    y: height * inset,
    width: width * share,
    height: height * share,
  };
}

export interface SafeAreas {
  action: SafeRect;
  title: SafeRect;
}

export function safeAreaRects(width: number, height: number): SafeAreas {
  return {
    action: safeRect(width, height, ACTION_SAFE),
    title: safeRect(width, height, TITLE_SAFE),
  };
}
