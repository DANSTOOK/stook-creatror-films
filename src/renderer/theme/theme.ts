import { create } from 'zustand';

/**
 * The editor's look: dark (as it has always been), light, or whichever the
 * system uses - and the accent colour. Chosen in Preferences, kept between
 * sessions, and put on <html> as data-theme and data-accent, which the
 * palette reads (theme/palette.css); detached windows mirror the attributes.
 */

export type ThemeChoice = 'dark' | 'light' | 'system';
export type AccentChoice = 'cyan' | 'blue' | 'violet' | 'green' | 'orange' | 'pink';

export const THEMES: readonly ThemeChoice[] = ['dark', 'light', 'system'];
/** Each accent with its swatch colour, for the picker. */
export const ACCENTS: ReadonlyArray<{ id: AccentChoice; swatch: string }> = [
  { id: 'cyan', swatch: '#06c4de' },
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
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<{ theme: string; accent: string; v: number }>;
    return {
      theme: THEMES.includes(parsed.theme as ThemeChoice) ? (parsed.theme as ThemeChoice) : 'dark',
      // Blue was the default before cyan (v1.80): a blue kept from then was never a choice, so it is cyan now.
      accent: ACCENTS.some((accent) => accent.id === parsed.accent) && !(parsed.accent === 'blue' && parsed.v !== 2) ? (parsed.accent as AccentChoice) : 'cyan',
    };
  } catch {
    return { theme: 'dark', accent: 'cyan' };
  }
}

function remember(state: { theme: ThemeChoice; accent: AccentChoice }): void {
  try {
    // v: 2 says the accent kept is one chosen with cyan on offer (see saved).
    window.localStorage.setItem(KEY, JSON.stringify({ ...state, v: 2 }));
  } catch {
    // Not kept: it still applies for this session.
  }
}

const systemQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

/** The theme a choice comes to now: 'system' is whichever Windows uses. */
export const resolvedTheme = (choice: ThemeChoice): 'dark' | 'light' => (choice === 'system' ? (systemQuery()?.matches ? 'light' : 'dark') : choice);

function paint(resolved: 'dark' | 'light'): void {
  const root = document.documentElement;
  if (resolved === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

function apply(state: { theme: ThemeChoice; accent: AccentChoice }): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  paint(resolvedTheme(state.theme));
  if (state.accent === 'cyan') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', state.accent);
  // Windows' caption buttons, native scrollbars and menus: the main process paints those.
  // Following the system, the main process answers with Windows' own look:
  // until it stopped forcing one, the page could not see it.
  void window.filmora?.setAppearance?.(state.theme, resolvedTheme(state.theme))?.then((resolved) => {
    if (useThemeStore.getState().theme === state.theme && state.theme === 'system') paint(resolved);
  });
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...(typeof window === 'undefined' ? { theme: 'dark' as const, accent: 'cyan' as const } : saved()),
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
