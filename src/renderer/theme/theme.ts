import { create } from 'zustand';

/**
 * The editor's look: dark (as it has always been), light, or whichever the
 * system uses - and the accent colour. Chosen in Preferences, kept between
 * sessions, and put on <html> as data-theme and data-accent, which the
 * palette reads (theme/palette.css); detached windows mirror the attributes.
 */

export type ThemeChoice = 'dark' | 'light' | 'system';
export type AccentChoice = 'blue' | 'violet' | 'green' | 'orange' | 'pink';

export const THEMES: readonly ThemeChoice[] = ['dark', 'light', 'system'];
/** Each accent with its swatch colour, for the picker. */
export const ACCENTS: ReadonlyArray<{ id: AccentChoice; swatch: string }> = [
  { id: 'blue', swatch: '#2563eb' },
  { id: 'violet', swatch: '#7c3aed' },
  { id: 'green', swatch: '#047857' },
  { id: 'orange', swatch: '#c2410c' },
  { id: 'pink', swatch: '#be185d' },
];

const KEY = 'scf.theme';

interface ThemeState {
  theme: ThemeChoice;
  accent: AccentChoice;
  setTheme(theme: ThemeChoice): void;
  setAccent(accent: AccentChoice): void;
}

function saved(): { theme: ThemeChoice; accent: AccentChoice } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<{ theme: string; accent: string }>;
    return {
      theme: THEMES.includes(parsed.theme as ThemeChoice) ? (parsed.theme as ThemeChoice) : 'dark',
      accent: ACCENTS.some((accent) => accent.id === parsed.accent) ? (parsed.accent as AccentChoice) : 'blue',
    };
  } catch {
    return { theme: 'dark', accent: 'blue' };
  }
}

function remember(state: { theme: ThemeChoice; accent: AccentChoice }): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not kept: it still applies for this session.
  }
}

const systemQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

/** The theme a choice comes to now: 'system' is whichever Windows uses. */
export const resolvedTheme = (choice: ThemeChoice): 'dark' | 'light' => (choice === 'system' ? (systemQuery()?.matches ? 'light' : 'dark') : choice);

function apply(state: { theme: ThemeChoice; accent: AccentChoice }): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (resolvedTheme(state.theme) === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  if (state.accent === 'blue') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', state.accent);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...(typeof window === 'undefined' ? { theme: 'dark' as const, accent: 'blue' as const } : saved()),
  setTheme(theme) {
    set({ theme });
    remember({ theme, accent: get().accent });
    apply(get());
  },
  setAccent(accent) {
    set({ accent });
    remember({ theme: get().theme, accent });
    apply(get());
  },
}));

let installed = false;

/** Once, before the first render (main.tsx): the saved look, and the system's when it is followed. */
export function installTheme(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apply(useThemeStore.getState());
  systemQuery()?.addEventListener('change', () => apply(useThemeStore.getState()));
}
