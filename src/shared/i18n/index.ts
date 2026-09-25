import { en, type Messages } from './en';
import { es } from './es';

/**
 * The interface language.
 *
 * Deliberately tiny and dependency-free: two flat dictionaries and a lookup.
 * Both processes use it - the renderer for the page, the main process for the
 * native menu - so it lives in shared and imports nothing from either side.
 *
 * English is the default, and the fallback for any key a translation lacks,
 * so an unfinished dictionary shows English rather than a raw key.
 */

export type Language = 'en' | 'es';
export type MessageKey = keyof Messages;
export type MessageParams = Record<string, string | number>;

export const DEFAULT_LANGUAGE: Language = 'en';

/** Each language named in itself, as a language picker should show it. */
export const LANGUAGES: ReadonlyArray<{ id: Language; name: string }> = [
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
];

const dictionaries: Record<Language, Partial<Messages>> = { en, es };

export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'es';

/** The BCP 47 tag for dates and numbers in this language. */
export const localeOf = (language: Language): string => (language === 'es' ? 'es-ES' : 'en-GB');

/**
 * A message in `language`, with `{name}` placeholders filled from `params`.
 * Unknown placeholders are left as written, which makes a typo visible.
 */
export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[language][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}
