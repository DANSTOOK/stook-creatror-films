import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { ACCENTS, THEMES, useThemeStore, type AccentChoice, type ThemeChoice } from '@renderer/theme/theme';

/** Preferences: the editor's look - dark, light or the system's - and its accent colour (theme/theme.ts). */

const THEME_ICON: Record<ThemeChoice, typeof Sun> = { dark: Moon, light: Sun, system: Monitor };
const THEME_LABEL: Record<ThemeChoice, 'prefs.themeDark' | 'prefs.themeLight' | 'prefs.themeSystem'> = {
  dark: 'prefs.themeDark',
  light: 'prefs.themeLight',
  system: 'prefs.themeSystem',
};
const ACCENT_LABEL: Record<AccentChoice, 'prefs.accentCyan' | 'prefs.accentBlue' | 'prefs.accentViolet' | 'prefs.accentGreen' | 'prefs.accentOrange' | 'prefs.accentPink'> = {
  cyan: 'prefs.accentCyan',
  blue: 'prefs.accentBlue',
  violet: 'prefs.accentViolet',
  green: 'prefs.accentGreen',
  orange: 'prefs.accentOrange',
  pink: 'prefs.accentPink',
};

export function AppearancePicker(): JSX.Element {
  const t = useT();
  const theme = useThemeStore((state) => state.theme);
  const accent = useThemeStore((state) => state.accent);
  const setTheme = useThemeStore((state) => state.setTheme);
  const setAccent = useThemeStore((state) => state.setAccent);
  return (
    <div className="space-y-2" data-testid="prefs-appearance">
      <span className="field-label flex items-center gap-1.5">
        <Palette size={12} aria-hidden />
        {t('prefs.appearance')}
      </span>
      <div role="radiogroup" aria-label={t('prefs.theme')} className="grid grid-cols-3 gap-1.5">
        {THEMES.map((choice) => {
          const Icon = THEME_ICON[choice];
          const on = theme === choice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`prefs-theme-${choice}`}
              className={`press flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                on ? 'border-accent/70 bg-accent/15 font-medium text-slate-100' : 'border-panel-700 bg-panel-900 text-slate-400 hover:border-panel-600 hover:text-slate-200'
              }`}
              onClick={() => setTheme(choice)}
            >
              <Icon size={13} aria-hidden />
              {t(THEME_LABEL[choice])}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-2xs text-slate-400">{t('prefs.accent')}</span>
        <div role="radiogroup" aria-label={t('prefs.accent')} className="flex gap-1.5">
          {ACCENTS.map((option) => {
            const on = accent === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={t(ACCENT_LABEL[option.id])}
                title={t(ACCENT_LABEL[option.id])}
                data-testid={`prefs-accent-${option.id}`}
                className={`press grid h-6 w-6 place-items-center rounded-full ring-offset-2 ring-offset-panel-900 transition-shadow ${on ? 'ring-2 ring-slate-300' : 'hover:ring-1 hover:ring-slate-500'}`}
                style={{ backgroundColor: option.swatch }}
                onClick={() => setAccent(option.id)}
              >
                {on && <Check size={12} className="text-white" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
