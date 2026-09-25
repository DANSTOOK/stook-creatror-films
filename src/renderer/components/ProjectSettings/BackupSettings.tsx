import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { currentLocale, useLanguageStore, useT } from '@renderer/i18n';

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
  const t = useT();
  const language = useLanguageStore((state) => state.language);

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
    <div className="space-y-2">
      <label className="flex flex-col gap-1">
        <span className="field-label">{t('backups.autosave')}</span>
        <select
          className="numeric-input"
          data-testid="autosave-interval"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        >
          {AUTOSAVE_INTERVALS.map((value) => (
            <option key={value} value={value}>
              {autosaveLabel(value, language)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-2xs leading-relaxed text-slate-400">{t('backups.autosaveHint')}</p>

      <div className="space-y-1">
        <span className="field-label">{t('backups.earlier')}</span>
        {!projectPath && <p className="text-2xs text-slate-400">{t('backups.neverSaved')}</p>}
        {projectPath && backups?.length === 0 && <p className="text-2xs text-slate-400">{t('backups.none')}</p>}
        {backups && backups.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto" data-testid="backup-list">
            {backups.map((backup) => (
              <li key={backup.file} className="list-item flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                  <span className="timecode">
                    {new Date(backup.savedAt).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  <span className="pl-2 text-2xs text-slate-400">{relativeTime(backup.savedAt, now, language)}</span>
                </span>
                <button
                  type="button"
                  className="tool-button shrink-0"
                  disabled={busy}
                  title={t('backups.restoreHint')}
                  onClick={() => void restore(backup)}
                >
                  <RotateCcw size={12} />
                  {t('backups.restore')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
