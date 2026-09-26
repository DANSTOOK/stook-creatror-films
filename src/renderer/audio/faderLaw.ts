/**
 * Where a level sits on a fader and on a meter.
 *
 * A console fader is not linear in anything: the top quarter is the last
 * 6 dB, unity sits three quarters of the way up, and the bottom tenth holds
 * everything from -60 dB down to silence - so the travel goes where a mix is
 * actually set. This is that law, as straight segments in decibels between
 * the marks printed beside a fader; the meters use the same one, so a meter
 * reading lines up with the fader position that would give it.
 *
 * Levels are the project's linear gains (1 is unity, 2 is the top, +6 dB).
 */

export const FADER_TOP_DB = 20 * Math.log10(2);

/** (position 0-1, dB) marks, bottom to top. Below the first is silence. */
const MARKS: ReadonlyArray<readonly [number, number]> = [
  [0.02, -60],
  [0.25, -30],
  [0.5, -12],
  [0.75, 0],
  [1, FADER_TOP_DB],
];

/** The marks a fader's scale shows, in dB. */
export const SCALE_MARKS_DB: readonly number[] = [6, 0, -12, -30, -60];

export function dbToPosition(db: number): number {
  if (!Number.isFinite(db) || db <= MARKS[0][1]) {
    if (!Number.isFinite(db)) return 0;
    // Under -60 dB the last sliver runs down to silence.
    return Math.max(0, MARKS[0][0] * (1 - (MARKS[0][1] - db) / 60));
  }
  for (let index = 1; index < MARKS.length; index += 1) {
    const [position, value] = MARKS[index];
    const [lowPosition, lowValue] = MARKS[index - 1];
    if (db <= value) return lowPosition + ((db - lowValue) / (value - lowValue)) * (position - lowPosition);
  }
  return 1;
}

export function positionToDb(position: number): number {
  if (position <= 0) return -Infinity;
  if (position < MARKS[0][0]) return MARKS[0][1] - 60 * (1 - position / MARKS[0][0]);
  for (let index = 1; index < MARKS.length; index += 1) {
    const [top, value] = MARKS[index];
    const [low, lowValue] = MARKS[index - 1];
    if (position <= top) return lowValue + ((position - low) / (top - low)) * (value - lowValue);
  }
  return FADER_TOP_DB;
}

export const gainToDb = (gain: number): number => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

/** A linear gain as a fader position, 0 to 1. */
export const gainToPosition = (gain: number): number => dbToPosition(gainToDb(gain));

/**
 * A fader position as a linear gain. The very bottom is silence, and a
 * position within a hair of unity snaps to it: a mix left at "-0.1 dB"
 * because the thumb landed a pixel off is not a choice anyone made.
 */
export function positionToGain(position: number): number {
  if (position <= 0.001) return 0;
  if (position >= 0.999) return 2;
  const db = positionToDb(position);
  if (Math.abs(db) < 0.1) return 1;
  return Math.min(2, 10 ** (db / 20));
}
