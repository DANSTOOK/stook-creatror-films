import type { TitleContent } from '@shared/types';
import { FALLBACK_FAMILY } from './titleStyle';
import interLicence from '@renderer/assets/fonts/Inter-LICENSE.txt?raw';
import sourceSerifLicence from '@renderer/assets/fonts/SourceSerif4-LICENSE.md?raw';
import oswaldLicence from '@renderer/assets/fonts/Oswald-OFL.txt?raw';

/**
 * The fonts titles are drawn with.
 *
 * Three families ship with the app (declared with @font-face in index.css,
 * loaded from files inside the app - never from the network), so a project
 * made with them looks the same on any computer. Any family installed on
 * this computer can be used as well; one that is not installed where the
 * project is opened is drawn in Inter instead, and the editor says so.
 */

export interface BundledFont {
  family: string;
  /** The weights the file covers - they are variable fonts. */
  minWeight: number;
  maxWeight: number;
  licence: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'Inter', minWeight: 100, maxWeight: 900, licence: interLicence },
  { family: 'Source Serif 4', minWeight: 200, maxWeight: 900, licence: sourceSerifLicence },
  { family: 'Oswald', minWeight: 200, maxWeight: 700, licence: oswaldLicence },
];

export const isBundledFamily = (family: string): boolean => BUNDLED_FONTS.some((font) => font.family === family);

/**
 * The CSS font for a line: the family asked for, then Inter, then whatever
 * the system has. The browser walks the list per character, so a family
 * that is missing falls to Inter, and a character Inter lacks (Japanese,
 * Devanagari, an emoji) falls to the system font that has it.
 */
export function fontString(family: string, weight: number, sizePx: number): string {
  const clean = family.replace(/["\\]/g, '');
  const stack = clean === FALLBACK_FAMILY ? `"${FALLBACK_FAMILY}"` : `"${clean}", "${FALLBACK_FAMILY}"`;
  return `${weight} ${sizePx}px ${stack}, sans-serif`;
}

/* The families on this computer ------------------------------------------------ */

let localFamilies: ReadonlySet<string> | null = null;
let localRequest: Promise<ReadonlySet<string>> | null = null;
const listeners = new Set<() => void>();

/**
 * The font families installed on this computer, from the Local Font Access
 * API. Asked once; an empty set where the API is missing, which only means
 * nothing can be called missing.
 */
export function loadLocalFamilies(): Promise<ReadonlySet<string>> {
  localRequest ??= (async () => {
    const query = (window as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
    let families: ReadonlySet<string> = new Set();
    try {
      if (typeof query === 'function') families = new Set((await query.call(window)).map((font) => font.family));
    } catch {
      // Refused or unavailable: nothing is known, so nothing is reported missing.
    }
    localFamilies = families;
    for (const listener of listeners) listener();
    return families;
  })();
  return localRequest;
}

/** The installed families, or null until they have been asked for. */
export const knownLocalFamilies = (): ReadonlySet<string> | null => localFamilies;

/** Called once the installed families are known. */
export function onLocalFamilies(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether a title's family is missing here: not one of ours and not
 * installed. False while that is not known yet - a warning that flickers on
 * and off at start-up would be worse than one that arrives a moment late.
 */
export function isFamilyMissing(family: string): boolean {
  if (isBundledFamily(family) || !localFamilies || localFamilies.size === 0) return false;
  return !localFamilies.has(family);
}

/** The families titles in this project ask for that this computer lacks, once each. */
export function missingFamilies(titles: Iterable<TitleContent>): string[] {
  const missing = new Set<string>();
  for (const title of titles) if (isFamilyMissing(title.style.fontFamily)) missing.add(title.style.fontFamily);
  return [...missing];
}

/* Loading ----------------------------------------------------------------------- */

/**
 * The fonts a title needs, as CSS font strings. The size does not matter to
 * which file is loaded, so one nominal size stands for them all.
 */
const fontsOf = (title: TitleContent): string[] => [fontString(title.style.fontFamily, title.style.fontWeight, 16)];

/** The text to load faces for: the title's own, so every face its characters need is fetched. */
const sampleOf = (title: TitleContent): string => title.text.trim() || 'Ag';

/** Every face a title needs is loaded, so drawing it now draws the right letters. */
export function titleFontsReady(title: TitleContent): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true;
  const sample = sampleOf(title);
  return fontsOf(title).every((font) => {
    try {
      return document.fonts.check(font, sample);
    } catch {
      return true;
    }
  });
}

const pending = new Map<string, Promise<void>>();

/**
 * Load what a title needs. The files are inside the app, so this takes
 * milliseconds - but a frame drawn before it finishes would be drawn in a
 * fallback face, and an export must never do that.
 */
export function loadTitleFonts(title: TitleContent): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const sample = sampleOf(title);
  return Promise.all(
    fontsOf(title).map((font) => {
      const key = `${font}|${sample}`;
      let request = pending.get(key);
      if (!request) {
        request = document.fonts
          .load(font, sample)
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return request;
    }),
  ).then(() => undefined);
}
