import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';

import { hasNativeBridge } from '@renderer/media/importMedia';
import { AUTOSAVE_INTERVALS, autosaveLabel } from '@renderer/project/autosave';
import { useAutosaveMinutes } from '@renderer/project/useAutosave';
import { relativeTime } from '@renderer/project/projectSession';
import { useSessionStore } from '@renderer/store/useSessionStore';
import type { ProjectBackup } from '@shared/types/ipc';

/**
 * Autosave, and the copies it leaves behind.
 *
 * Every save - by hand or on the timer - keeps the file as it was before, and
 * this is where those copies can be looked at and opened. They are listed by
 * when the save that replaced them happened, because that is the question
 * being asked: "put me back to how it was before lunch".
 *
 * Restoring loads the copy into the editor and leaves it unsaved, so the
 * project file is untouched until the user decides. If they do save, the
 * version they just replaced becomes a backup in turn - there is no way to
 * lose the current state by looking at an old one.
 */

export interface BackupSettingsProps {
  /** Load these contents into the editor as unsaved work. */
  onRestore(contents: string, savedAt: string): Promise<void> | void;
}

export function BackupSettings({ onRestore }: BackupSettingsProps): JSX.Element {
  const [minutes, setMinutes] = useAutosaveMinutes();
  const projectPath = useSessionStore((state) => state.projectPath);
  const [backups, setBackups] = useState<ProjectBackup[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasNativeBridge() || !projectPath) {
      setBackups([]);
      return;
    }
    let live = true;
    void window.filmora
      .projectsBackups(projectPath)
      .then((list) => live && setBackups(list))
      .catch(() => live && setBackups([]));
    return () => {
      live = false;
    };
  }, [projectPath]);

  const restore = useCallback(
    async (backup: ProjectBackup) => {
      if (busy) return;
      setBusy(true);
      try {
        const contents = await window.filmora.projectsBackupRead(backup.file).catch(() => null);
        if (contents) await onRestore(contents, backup.savedAt);
      } finally {
        setBusy(false);
      }
    },
    [busy, onRestore],
  );

  const now = Date.now();

  return (
    <section className="space-y-2 border-t border-panel-700 pt-3">
      <span className="section-title flex items-center gap-1.5">
        <History size={12} />
        Autosave and backups
      </span>

      <label className="flex flex-col gap-1">
        <span className="field-label">Autosave</span>
        <select
          className="numeric-input"
          data-testid="autosave-interval"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        >
          {AUTOSAVE_INTERVALS.map((value) => (
            <option key={value} value={value}>
              {autosaveLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-2xs leading-relaxed text-slate-500">
        A saved project is written back to its own file. Work that has never
        been saved is kept in the app instead, and offered back on the next
        start - nothing is written anywhere you did not choose.
      </p>

      <div className="space-y-1">
        <span className="field-label">Earlier versions of this project</span>
        {!projectPath && (
          <p className="text-2xs text-slate-500">Save the project once, and its earlier versions are kept here.</p>
        )}
        {projectPath && backups?.length === 0 && (
          <p className="text-2xs text-slate-500">No earlier versions yet - the first save is the first copy.</p>
        )}
        {backups && backups.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto" data-testid="backup-list">
            {backups.map((backup) => (
              <li key={backup.file} className="list-item flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                  {new Date(backup.savedAt).toLocaleString()}
                  <span className="pl-2 text-2xs text-slate-500">{relativeTime(backup.savedAt, now)}</span>
                </span>
                <button
                  type="button"
                  className="tool-button shrink-0"
                  disabled={busy}
                  title="Open this version in the editor, leaving the project file alone"
                  onClick={() => void restore(backup)}
                >
                  <RotateCcw size={12} />
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
