/**
 * How a level and a pan position are written, everywhere they appear.
 *
 * The mixer said "-6.0 dB" and "L30" while the inspector showed the same clip
 * as "0.50" and "-0.30" - two readings of one value, one of them in a unit
 * nobody mixes in. Both use these now.
 */

/** A linear gain as decibels: 1 is "0.0 dB", 0.5 is "-6.0 dB", silence is "-inf dB". */
export function dbLabel(linear: number): string {
  if (linear <= 0.0001) return '-inf dB';
  const db = 20 * Math.log10(linear);
  // -0.0 reads as a sign error; anything that rounds to zero is plain 0.0.
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

/** A pan position: "C" in the middle, "L30" or "R100" either side. */
export function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
}

/** A gain in decibels already, with its sign: "+3.0 dB", "-12.5 dB". */
export function signedDb(db: number): string {
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}
