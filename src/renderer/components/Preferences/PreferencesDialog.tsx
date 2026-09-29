import { useId, useState } from 'react';
import { Languages, Settings, Timer } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import {
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  TRANSITION_LENGTH_PRESETS,
  cleanTransitionSeconds,
  useTransitionLengthStore,
} from '@renderer/timing/transitionLength';
import { LANGUAGES, isLanguage } from '@shared/i18n';
import { useLanguageStore, useT } from '@renderer/i18n';

/**
 * Settings of this computer rather than of a project.
 *
 * The interface language, and how long a new transition is. Each applies the
 * moment it is chosen - the language to the page, the native menu and the
 * close prompt - with nothing to restart, and is kept on this machine beside
 * the panel sizes. English and one second are the defaults.
 */

/**
 * The four usual lengths, and Custom, which shows a field for any other.
 * A remembered length that is not one of the four opens on Custom.
 */
function TransitionLengthSelect(): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const seconds = useTransitionLengthStore((state) => state.seconds);
  const setSeconds = useTransitionLengthStore((state) => state.setSeconds);
  const [custom, setCustom] = useState(() => !TRANSITION_LENGTH_PRESETS.includes(seconds));
  const [draft, setDraft] = useState(String(seconds));
  const selectId = useId();
  const hintId = useId();
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="field-label flex items-center gap-1.5">
        <Timer size={12} aria-hidden />
        {t('prefs.transitionLength')}
      </label>
      <div className="flex items-center gap-2">
        <select
          id={selectId}
          className="numeric-input flex-1"
          data-testid="prefs-transition-length"
          aria-describedby={hintId}
          value={custom ? 'custom' : String(seconds)}
          onChange={(event) => {
            if (event.target.value === 'custom') {
              setDraft(String(seconds));
              setCustom(true);
              return;
            }
            setCustom(false);
            setSeconds(Number(event.target.value));
          }}
        >
          {TRANSITION_LENGTH_PRESETS.map((option) => (
            <option key={option} value={String(option)}>
              {t('prefs.seconds', { n: number.format(option) })}
            </option>
          ))}
          <option value="custom">{t('prefs.custom')}</option>
        </select>
        {custom && (
          <input
            type="number"
            className="numeric-input w-24"
            data-testid="prefs-transition-custom"
            aria-label={t('prefs.customSeconds')}
            min={MIN_TRANSITION_SECONDS}
            max={MAX_TRANSITION_SECONDS}
            step={0.1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // Taken as it is typed when it makes sense; clamped on leaving.
              const typed = Number(event.target.value);
              if (event.target.value !== '' && typed >= MIN_TRANSITION_SECONDS && typed <= MAX_TRANSITION_SECONDS) setSeconds(typed);
            }}
            onBlur={() => {
              const clean = cleanTransitionSeconds(draft === '' ? seconds : draft) ?? seconds;
              setSeconds(clean);
              setDraft(String(clean));
            }}
          />
        )}
      </div>
      <p id={hintId} className="text-2xs leading-relaxed text-slate-400">
        {t('prefs.transitionLengthHint')}
      </p>
    </div>
  );
}

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
      <div className="pt-2">
        <TransitionLengthSelect />
      </div>
    </Dialog>
  );
}

export default PreferencesDialog;
