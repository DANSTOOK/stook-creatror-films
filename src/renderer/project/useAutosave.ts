import { useEffect, useRef, useState } from 'react';

import { hasNativeBridge } from '@renderer/media/importMedia';
import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { documentIsDirty, useSessionStore } from '@renderer/store/useSessionStore';
import {
  AUTOSAVE_STORAGE_KEY,
  AUTOSAVE_TICK_MS,
  DEFAULT_AUTOSAVE_MINUTES,
  autosaveAction,
  readAutosaveMinutes,
} from './autosave';

/**
 * The timer behind the autosave rules.
 *
 * The decision is made in `autosave.ts`, which is why there is so little here:
 * every fifteen seconds this asks what to do and does it. Two things it is
 * careful about:
 *
 * - It never saves while a save, an export or a project swap is in flight. A
 *   save that overlaps an export would have both reaching for the decoders.
 * - It saves without a thumbnail. Rendering one means taking the renderer
 *   exclusively, and an automatic save must never take the picture away from
 *   somebody who is working.
 */

/** Read once at start-up; the setting is changed through `setAutosaveMinutes`. */
function storedMinutes(): number {
  try {
    return readAutosaveMinutes(window.localStorage.getItem(AUTOSAVE_STORAGE_KEY));
  } catch {
    return DEFAULT_AUTOSAVE_MINUTES;
  }
}

const listeners = new Set<(minutes: number) => void>();
let minutes = storedMinutes();

export function autosaveMinutes(): number {
  return minutes;
}

export function setAutosaveMinutes(value: number): void {
  minutes = value;
  try {
    window.localStorage.setItem(AUTOSAVE_STORAGE_KEY, String(value));
  } catch {
    // A blocked store just means the setting lasts for this session.
  }
  for (const listener of listeners) listener(value);
}

/** The setting, kept in step across every place that shows it. */
export function useAutosaveMinutes(): [number, (value: number) => void] {
  const [value, setValue] = useState(minutes);
  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return [value, setAutosaveMinutes];
}

export interface AutosaveHooks {
  /** Save the open project back to its own file. Returns whether it worked. */
  save(): Promise<boolean>;
  /** Something else is using the renderer or the file. */
  isBusy(): boolean;
  /** Say what went wrong. */
  report(message: string): void;
}

export function useAutosave({ save, isBusy, report }: AutosaveHooks): void {
  const [interval] = useAutosaveMinutes();
  const lastSaveRef = useRef(Date.now());
  const snapshotRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!hasNativeBridge()) return undefined;

    // A changed interval starts its own clock: switching from 15 minutes to 2
    // should not fire immediately because 13 minutes have already passed.
    lastSaveRef.current = Date.now();

    const tick = async (): Promise<void> => {
      if (runningRef.current) return;
      const session = useSessionStore.getState();
      const action = autosaveAction({
        minutes: interval,
        dirty: session.view === 'editor' && documentIsDirty(),
        hasPath: Boolean(session.projectPath),
        busy: isBusy(),
        snapshotOnDisk: snapshotRef.current,
        sinceMs: Date.now() - lastSaveRef.current,
      });
      if (action === 'wait' || action === 'idle') return;

      runningRef.current = true;
      try {
        if (action === 'clear') {
          await window.filmora.projectsRecoveryClear().catch(() => undefined);
          snapshotRef.current = false;
          return;
        }

        if (action === 'snapshot') {
          await window.filmora
            .projectsRecoveryWrite({
              name: session.projectName,
              path: session.projectPath,
              contents: JSON.stringify(useProjectStore.getState().toDocument()),
            })
            .catch(() => undefined);
          snapshotRef.current = true;
          lastSaveRef.current = Date.now();
          return;
        }

        const saved = await save();
        lastSaveRef.current = Date.now();
        if (saved && snapshotRef.current) {
          await window.filmora.projectsRecoveryClear().catch(() => undefined);
          snapshotRef.current = false;
        }
        if (!saved) report(t('notify.autosaveFailed'));
      } finally {
        runningRef.current = false;
      }
    };

    // The interface tests drive the same decision the timer drives, rather
    // than sitting through five minutes of it. `due` puts the clock back, so
    // the next decision is the one that would be made when the interval is up.
    (window as { __scfAutosave?: object }).__scfAutosave = {
      tick: () => tick(),
      due: () => {
        lastSaveRef.current = 0;
      },
      interval,
    };

    const timer = window.setInterval(() => void tick(), AUTOSAVE_TICK_MS);
    return () => {
      window.clearInterval(timer);
      delete (window as { __scfAutosave?: object }).__scfAutosave;
    };
  }, [interval, isBusy, report, save]);
}
