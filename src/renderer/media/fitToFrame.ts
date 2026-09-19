import type { Vector2D } from '@shared/types';

/**
 * The scale that shows a picture whole, at its own shape, inside the frame.
 *
 * A clip at scale 1 fills the project frame whatever shape it is, so a phone
 * photo in a 16:9 project came in stretched sideways and a 4:3 still squashed.
 * Filmora - and Resolve's "scale entire image to fit" - put it in whole
 * instead, with bars on the sides or top and bottom, and let you size it from
 * there. This is that fit: the picture as large as it can be without
 * overflowing or being distorted.
 *
 * Applied when a clip is placed, rather than by changing what scale 1 means in
 * the renderer: projects saved before this still look exactly as they did.
 */

/** Shapes this close to the frame's already fill it; no bars for a rounding error. */
const SAME_SHAPE = 0.01;

export function fitScale(
  media: { width: number; height: number },
  frame: { width: number; height: number },
): Vector2D | null {
  if (!(media.width > 0 && media.height > 0 && frame.width > 0 && frame.height > 0)) return null;

  const mediaShape = media.width / media.height;
  const frameShape = frame.width / frame.height;
  if (Math.abs(mediaShape / frameShape - 1) < SAME_SHAPE) return null;

  return mediaShape < frameShape
    ? // Narrower than the frame (a portrait photo): full height, bars at the sides.
      { x: mediaShape / frameShape, y: 1 }
    : // Wider (a panorama): full width, bars top and bottom.
      { x: 1, y: frameShape / mediaShape };
}
