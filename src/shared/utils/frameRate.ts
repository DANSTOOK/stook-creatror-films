/**
 * Frame-rate normalisation, shared by both probing paths.
 *
 * Neither source of truth is clean. ffmpeg reports the AVERAGE rate for a
 * variable-frame-rate file - a phone recording that is nominally 30 fps prints
 * as "29.99 fps, 30 tbr" - and measuring presentation timestamps in the browser
 * is accurate but never exact. Feeding either raw number into the project makes
 * a timeline that no container can represent cleanly: exporting 180 frames at
 * 29.99 fps yields a file that declares 29 fps and runs 3.5% slow.
 */

/** Frame rates worth snapping a noisy measurement onto. */
export const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/** Widest relative error still treated as "this is really that rate". */
const SNAP_TOLERANCE = 0.04;

/**
 * Snap a measured or averaged rate to the nearest standard one, within 4%.
 *
 * A genuinely unusual rate (a 40 fps timelapse, say) is further than that from
 * every standard rate and survives untouched.
 */
export function snapFrameRate(measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return 0;

  let best = measured;
  let bestError = Infinity;
  for (const rate of STANDARD_RATES) {
    const error = Math.abs(rate - measured) / rate;
    if (error < bestError) {
      bestError = error;
      best = rate;
    }
  }

  return bestError <= SNAP_TOLERANCE ? best : Math.round(measured * 1000) / 1000;
}
