/**
 * Typing a value into the mixer.
 *
 * A fader is for finding a level by ear; a number is for setting the one you
 * already know - "-6.0", not "somewhere near the third mark". The readouts
 * under the faders become fields, and these read what was typed.
 *
 * Every parser returns null for anything it cannot make sense of, so the field
 * can put back what was there instead of guessing. Pure, and tested directly.
 */

import { FADER_TOP_DB } from '@renderer/audio/faderLaw';

/** The loudest a fader goes: +6.02 dB, a gain of 2. */
export const MAX_GAIN = 2;

/** Below this the fader is silent, and the readout says "-inf dB". */
export const SILENT_DB = -60;

const SILENCE = /^-?\s*(inf(inity)?|∞)$/i;

/**
 * A typed level, in decibels, as a linear gain.
 *
 * Accepts what the readout shows ("-6.0 dB", "+3.0 dB"), what people type
 * ("-6", "3"), and silence ("-inf"). Louder than the fader goes is clamped
 * rather than refused: the intent is clear, and the fader has a top.
 */
export function gainFromText(text: string): number | null {
  const cleaned = text.trim().replace(/db$/i, '').trim();
  if (cleaned === '') return null;
  if (SILENCE.test(cleaned)) return 0;

  const db = Number(cleaned.replace(',', '.').replace(/^\+/, ''));
  if (!Number.isFinite(db)) return null;
  if (db <= SILENT_DB) return 0;
  if (db >= FADER_TOP_DB) return MAX_GAIN;
  return 10 ** (db / 20);
}

/**
 * A typed pan position, as -1 (hard left) to 1 (hard right).
 *
 * Accepts what the readout shows ("C", "L30", "R100"), signed hundredths
 * ("-30" is 30 left), and the raw -1..1 the project stores ("0.5"), which is
 * what somebody who has read the file would try.
 */
export function panFromText(text: string): number | null {
  const cleaned = text.trim();
  if (cleaned === '') return null;
  if (/^c(entre|enter)?$/i.test(cleaned)) return 0;

  const sided = /^([lr])\s*(\d+(?:[.,]\d+)?)$/i.exec(cleaned);
  if (sided) {
    const amount = Number(sided[2].replace(',', '.')) / 100;
    if (!Number.isFinite(amount)) return null;
    return clamp((sided[1].toLowerCase() === 'l' ? -1 : 1) * amount, -1, 1);
  }

  const value = Number(cleaned.replace(',', '.').replace(/^\+/, ''));
  if (!Number.isFinite(value)) return null;
  // "0.5" is half right; "50" is the same thing written as the readout does.
  return clamp(Math.abs(value) <= 1 ? value : value / 100, -1, 1);
}

/** A typed plain number, clamped to its control's range. */
export function numberFromText(text: string, min: number, max: number): number | null {
  const cleaned = text.trim().replace(',', '.').replace(/^\+/, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return clamp(value, min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
