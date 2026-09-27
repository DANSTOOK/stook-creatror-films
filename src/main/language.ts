import { DEFAULT_LANGUAGE, translate, type Language, type MessageKey, type MessageParams } from '@shared/i18n';

/**
 * The language the page reported last, for everything the main process says.
 *
 * Kept apart from the menu (appMenu.ts, which imports Electron) so that the
 * modules the unit tests load - the export pipeline, the YouTube client, the
 * proxy and filmstrip stores - can speak it without dragging Electron in.
 * English until the page says otherwise, which it does with its first menu
 * state, before anything can go wrong.
 */
let current: Language = DEFAULT_LANGUAGE;

export const mainLanguage = (): Language => current;

export function setMainLanguage(language: Language): void {
  current = language;
}

/**
 * A message from the main process in the language the page is showing.
 *
 * Native dialog titles, file-type names and the errors a handler throws are
 * read by the person at the editor. A thrown error reaches the page wrapped
 * ("Error invoking remote method ..."), and the page strips the wrapper
 * before showing it (renderer/errorText.ts).
 */
export const mt = (key: MessageKey, params?: MessageParams): string => translate(current, key, params);

/**
 * The end of what a tool printed on failure: the technical detail a message
 * keeps (ffmpeg's last lines), trimmed to something a person can read.
 */
export function lastLines(text: string, lines = 3, limit = 400): string {
  const kept = text.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join(' / ');
  return kept.length > limit ? `…${kept.slice(-limit)}` : kept;
}
