import { useEffect, useState } from 'react';
import { CloudUpload, FolderOpen } from 'lucide-react';
import type { CloudBackupState } from '@shared/types/ipc';
import { currentLocale, useT } from '@renderer/i18n';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { notify } from '@renderer/notifications/notifications';

/**
 * Preferences > Cloud backup: a copy of every save in OneDrive's, Google
 * Drive's or Dropbox's folder on this computer - found by itself - or in
 * any folder chosen; their own app uploads it (main/projects/cloudBackup.ts).
 */

const OFF = '';
const CHOOSE = '\u0000choose';

export function CloudBackup(): JSX.Element | null {
  const t = useT();
  const [state, setState] = useState<CloudBackupState | null>(null);
  const projectPath = useSessionStore((session) => session.projectPath);
  useEffect(() => {
    void window.filmora?.cloudBackupState?.().then(setState).catch(() => setState(null));
  }, []);
  if (!state) return null;

  const failed = (error: unknown): void => void notify(t('cloud.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
  const choose = (value: string): void => {
    const asked = value === CHOOSE ? window.filmora.cloudBackupChoose() : window.filmora.cloudBackupSet(value === OFF ? null : value);
    void asked.then(setState).catch(failed);
  };
  const known = state.candidates.some((candidate) => candidate.path === state.folder);
  const last = state.lastAt ? new Date(state.lastAt).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <section className="space-y-1.5" data-testid="cloud-backup" aria-label={t('cloud.title')}>
      <h3 className="field-label flex items-center gap-1.5">
        <CloudUpload size={12} aria-hidden />
        {t('cloud.title')}
      </h3>
      <div className="flex items-center gap-1.5">
        <select
          className="input-field h-control min-w-0 flex-1 px-2 text-xs"
          data-testid="cloud-backup-folder"
          value={state.folder ?? OFF}
          onChange={(event) => choose(event.target.value)}
        >
          <option value={OFF}>{t('cloud.off')}</option>
          {state.candidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.label} · {candidate.path}
            </option>
          ))}
          {state.folder && !known && <option value={state.folder}>{state.folder}</option>}
          <option value={CHOOSE}>{t('cloud.choose')}</option>
        </select>
        {state.folder && (
          <button type="button" className="tool-button h-control w-8 justify-center border border-panel-600 px-0" title={t('cloud.open')} aria-label={t('cloud.open')} onClick={() => void window.filmora.cloudBackupOpen()}>
            <FolderOpen size={13} />
          </button>
        )}
      </div>
      {state.folder && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-slate-400" data-testid="cloud-backup-status">
            {state.lastError ? <span className="text-red-300">{t('cloud.failed', { detail: state.lastError })}</span> : last ? t('cloud.last', { when: last }) : t('cloud.none')}
          </p>
          {projectPath && (
            <button
              type="button"
              data-testid="cloud-backup-now"
              className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
              onClick={() => void window.filmora.cloudBackupNow(projectPath).then(setState).catch(failed)}
            >
              {t('cloud.now')}
            </button>
          )}
        </div>
      )}
      <p className="text-2xs leading-relaxed text-slate-400">{t(state.candidates.length > 0 ? 'cloud.hint' : 'cloud.hintNone')}</p>
    </section>
  );
}
