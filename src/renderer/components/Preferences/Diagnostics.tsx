import { useEffect, useState } from 'react';
import { Bug } from 'lucide-react';
import type { LogState } from '@shared/types/ipc';
import { useT } from '@renderer/i18n';
import { copyDiagnostics } from '@renderer/diagnostics/appLog';

/** Preferences > Diagnostics: today's errors, and the log to open or copy (main/logging). */
export function Diagnostics(): JSX.Element | null {
  const t = useT();
  const [state, setState] = useState<LogState | null>(null);
  useEffect(() => {
    void window.filmora?.logState?.().then(setState).catch(() => setState(null));
  }, []);
  if (!state) return null;
  return (
    <section className="space-y-1.5" data-testid="diagnostics" aria-label={t('diag.title')}>
      <h3 className="field-label flex items-center gap-1.5">
        <Bug size={12} aria-hidden />
        {t('diag.title')}
      </h3>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-2xs text-slate-300" data-testid="diagnostics-count">
          {state.errorsToday > 0 ? t('diag.today', { count: state.errorsToday }) : t('diag.none')}
          {state.lastError && <span className="block truncate text-slate-400">{t('diag.last', { message: state.lastError.message })}</span>}
        </p>
        <button type="button" className="tool-button h-control-dense border border-panel-600 px-2 text-2xs" data-testid="diagnostics-open" onClick={() => void window.filmora.logOpen()}>
          {t('diag.open')}
        </button>
        <button type="button" className="tool-button h-control-dense border border-panel-600 px-2 text-2xs" data-testid="diagnostics-copy" onClick={() => void copyDiagnostics()}>
          {t('diag.copy')}
        </button>
      </div>
      <p className="text-2xs leading-relaxed text-slate-400">{t('diag.hint')}</p>
    </section>
  );
}
