/**
 * When to save without being asked.
 *
 * The rules are here, away from the timer, because "did it save when it should
 * have" is a question about a decision rather than about a clock: given how
 * long it has been, whether anything changed and whether the project has a
 * file yet, there is exactly one right answer, and it can be checked without
 * waiting five minutes for it.
 *
 * A project that has a file is written back to that file, which also leaves a
 * backup of what was there before. One that has never been saved cannot be
 * written anywhere the user chose, so it goes to a recovery snapshot instead
 * and is offered back on the next start. Nothing is ever written to a place
 * the user did not pick.
 */

/** The choices offered, in minutes. Zero is off. */
export const AUTOSAVE_INTERVALS = [0, 2, 5, 10, 15] as const;

export const DEFAULT_AUTOSAVE_MINUTES = 5;

export const AUTOSAVE_STORAGE_KEY = 'scf.autosave.v1';

/** How often the decision is made, however long the interval is. */
export const AUTOSAVE_TICK_MS = 15_000;

export type AutosaveAction =
  /** Write the project back to its own file. */
  | 'save'
  /** No file yet: keep a snapshot the next start can offer back. */
  | 'snapshot'
  /** Nothing to do, and nothing left behind to clear. */
  | 'idle'
  /** Saved or let go since the last snapshot: throw the snapshot away. */
  | 'clear'
  /** Not yet. */
  | 'wait';

export interface AutosaveState {
  /** The chosen interval, in minutes; 0 is off. */
  minutes: number;
  /** Are there edits since the last save? */
  dirty: boolean;
  /** Does the project have a file of its own? */
  hasPath: boolean;
  /** Something is already saving, exporting or being swapped in. */
  busy: boolean;
  /** Is a recovery snapshot on disk right now? */
  snapshotOnDisk: boolean;
  /** Milliseconds since the last automatic save. */
  sinceMs: number;
}

export function autosaveAction(state: AutosaveState): AutosaveAction {
  // Turning it off stops new snapshots but must also clean up after itself,
  // or an old snapshot would be offered back forever.
  if (state.minutes <= 0) return state.snapshotOnDisk ? 'clear' : 'idle';
  if (state.busy) return 'wait';
  // Saved by hand, or undone back to where it was saved: there is nothing left
  // to recover, so the snapshot has to go - otherwise the next start offers
  // work that is already in the file.
  if (!state.dirty) return state.snapshotOnDisk ? 'clear' : 'idle';
  if (state.sinceMs < state.minutes * 60_000) return 'wait';
  return state.hasPath ? 'save' : 'snapshot';
}

/** The stored preference, falling back to the default for anything unreadable. */
export function readAutosaveMinutes(raw: string | null): number {
  // Nothing stored is not the same as a stored zero: `Number(null)` is 0, and
  // reading that as "off" would turn autosave off for everyone who has never
  // touched the setting.
  if (raw === null || raw.trim() === '') return DEFAULT_AUTOSAVE_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_AUTOSAVE_MINUTES;
  return AUTOSAVE_INTERVALS.includes(value as (typeof AUTOSAVE_INTERVALS)[number])
    ? value
    : DEFAULT_AUTOSAVE_MINUTES;
}

/** "Off", or "Every 5 min" - what the setting says on screen. */
export function autosaveLabel(minutes: number): string {
  return minutes <= 0 ? 'Off' : `Every ${minutes} min`;
}

/** A clock time for the status line, in the viewer's own format. */
export function savedAtLabel(when: Date, locale?: string): string {
  return when.toLocaleTimeString(locale ? [locale] : [], { hour: '2-digit', minute: '2-digit' });
}
