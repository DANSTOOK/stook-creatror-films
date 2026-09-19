/**
 * J, K and L: the shuttle.
 *
 * L plays forward, J plays backward, K stops - and pressing J or L again goes
 * faster: 1x, 2x, 4x, 8x. It is the oldest muscle memory in editing, and the
 * reason editors rarely touch the play button.
 *
 * Pressing the opposite key slows down rather than jumping straight into
 * reverse, which is how Premiere and Resolve behave: L L L then J walks back
 * 8x, 4x, 2x before turning around.
 */

export const SHUTTLE_SPEEDS = [1, 2, 4, 8] as const;
export const MAX_SHUTTLE_SPEED = SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.length - 1];

/**
 * The rate after pressing L (`direction` 1) or J (`direction` -1).
 *
 * Positive is forwards, negative backwards, 0 is stopped.
 */
export function shuttleRate(current: number, direction: 1 | -1): number {
  if (current === 0) return direction;

  const goingThisWay = Math.sign(current) === direction;
  if (!goingThisWay) {
    // Slow down first; the next press past 1x turns around.
    const slower = Math.abs(current) / 2;
    return slower < 1 ? direction : Math.sign(current) * slower;
  }

  return Math.sign(current) * Math.min(MAX_SHUTTLE_SPEED, Math.abs(current) * 2);
}

/** What the transport shows for a rate: "8x", "-2x", or nothing at a standstill. */
export function shuttleLabel(rate: number): string {
  if (rate === 0 || rate === 1) return '';
  return `${rate > 0 ? '' : '-'}${Math.abs(rate)}x`;
}
