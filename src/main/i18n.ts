import { translate, type MessageKey, type MessageParams } from '@shared/i18n';
import { menuLanguage } from './appMenu';

/**
 * A message from the main process in the language the page is showing.
 *
 * Native dialog titles, file-type names and the errors a handler throws are
 * all read by the person at the editor, so they follow the page's language
 * like the menu does - the page reports it with the menu state. A thrown
 * error reaches the page wrapped ("Error invoking remote method ..."), and
 * the page strips the wrapper before showing it (renderer/errorText.ts).
 */
export const mt = (key: MessageKey, params?: MessageParams): string => translate(menuLanguage(), key, params);
