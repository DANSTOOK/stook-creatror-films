import { Languages, Settings } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { LANGUAGES, isLanguage } from '@shared/i18n';
import { useLanguageStore, useT } from '@renderer/i18n';

/**
 * Settings of this computer rather than of a project.
 *
 * For now, the interface language. It applies the moment it is chosen - the
 * page, the native menu, the close prompt - with nothing to restart, and is
 * kept on this machine beside the panel sizes. English is the default.
 */

/** The language picker on its own, for the start screen as well as here. */
export function LanguageSelect({ className = '' }: { className?: string }): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  return (
    <select
      className={`numeric-input ${className}`}
      aria-label={t('prefs.language')}
      data-testid="language-select"
      value={language}
      onChange={(event) => {
        if (isLanguage(event.target.value)) setLanguage(event.target.value);
      }}
    >
      {LANGUAGES.map((option) => (
        // Each language named in itself, so it can be found by someone who
        // cannot read the one on screen.
        <option key={option.id} value={option.id} lang={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}

export interface PreferencesDialogProps {
  onClose(): void;
  closing?: boolean;
}

export function PreferencesDialog({ onClose, closing = false }: PreferencesDialogProps): JSX.Element {
  const t = useT();
  return (
    <Dialog
      title={t('prefs.title')}
      icon={Settings}
      onClose={onClose}
      closing={closing}
      testId="preferences-dialog"
      widthClass="w-[420px]"
      bodyClassName="space-y-2 p-4"
      footer={
        <button type="button" className="button-primary" onClick={onClose}>
          {t('settings.done')}
        </button>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="field-label flex items-center gap-1.5">
          <Languages size={12} aria-hidden />
          {t('prefs.language')}
        </span>
        <LanguageSelect />
      </label>
      <p className="text-2xs leading-relaxed text-slate-400">{t('prefs.languageHint')}</p>
    </Dialog>
  );
}

export default PreferencesDialog;
