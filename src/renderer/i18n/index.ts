import { useCallback } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  localeOf,
  translate,
  type Language,
  type MessageKey,
  type MessageParams,
} from '@shared/i18n';

/**
 * The page's language.
 *
 * A setting of this machine, not of a project - somebody who reads Spanish
 * reads it in every project - so it lives in localStorage beside the panel
 * sizes and the autosave interval. English unless chosen otherwise.
 */

export const LANGUAGE_STORAGE_KEY = 'scf.language';

function loadLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

interface LanguageState {
  language: Language;
  setLanguage(language: Language): void;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: typeof window === 'undefined' ? DEFAULT_LANGUAGE : loadLanguage(),
  setLanguage(language) {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Not remembered, but still applied for this session.
    }
    if (typeof document !== 'undefined') document.documentElement.lang = language;
    set({ language });
  },
}));

/** A message in the current language, for code outside React (toasts, stores). */
export const t = (key: MessageKey, params?: MessageParams): string =>
  translate(useLanguageStore.getState().language, key, params);

/** The current locale tag, for dates and numbers. */
export const currentLocale = (): string => localeOf(useLanguageStore.getState().language);

/** `t` for a component: re-renders it when the language changes. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const language = useLanguageStore((state) => state.language);
  return useCallback((key: MessageKey, params?: MessageParams) => translate(language, key, params), [language]);
}

export type { Language, MessageKey };
