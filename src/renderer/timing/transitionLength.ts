import { create } from 'zustand';
import { DEFAULT_TRANSITION_SECONDS } from './transitions';

/**
 * How long a new transition is, in seconds.
 *
 * A habit of the person, not of a project - someone who cuts with half-second
 * dissolves wants them in every project - so, like the language, it lives in
 * localStorage on this machine. The presets are the ones Final Cut and
 * Premiere users reach for; anything else between a tenth of a second and ten
 * seconds can be typed.
 */

export const TRANSITION_LENGTH_STORAGE_KEY = 'scf.transitionSeconds';
export const TRANSITION_LENGTH_PRESETS: readonly number[] = [0.5, 1, 1.5, 2];
export const MIN_TRANSITION_SECONDS = 0.1;
export const MAX_TRANSITION_SECONDS = 10;

/** A length the preference can hold, or undefined for nonsense. */
export function cleanTransitionSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  // Hundredths are as fine as anyone types; clamped rather than refused.
  const rounded = Math.round(seconds * 100) / 100;
  return Math.min(MAX_TRANSITION_SECONDS, Math.max(MIN_TRANSITION_SECONDS, rounded));
}

function loadSeconds(): number {
  try {
    const stored = window.localStorage.getItem(TRANSITION_LENGTH_STORAGE_KEY);
    return (stored === null ? undefined : cleanTransitionSeconds(stored)) ?? DEFAULT_TRANSITION_SECONDS;
  } catch {
    return DEFAULT_TRANSITION_SECONDS;
  }
}

interface TransitionLengthState {
  seconds: number;
  setSeconds(seconds: number): void;
}

export const useTransitionLengthStore = create<TransitionLengthState>((set) => ({
  seconds: typeof window === 'undefined' ? DEFAULT_TRANSITION_SECONDS : loadSeconds(),
  setSeconds(value) {
    const seconds = cleanTransitionSeconds(value);
    if (seconds === undefined) return;
    try {
      window.localStorage.setItem(TRANSITION_LENGTH_STORAGE_KEY, String(seconds));
    } catch {
      // Not remembered, but used for the rest of this session.
    }
    set({ seconds });
  },
}));

/** A new transition's length in frames at `fps`, never shorter than `minimum`. */
export function newTransitionFrames(fps: number, minimum: number): number {
  return Math.max(minimum, Math.round(useTransitionLengthStore.getState().seconds * fps));
}
