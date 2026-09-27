/**
 * What an error says, as a person should read it.
 *
 * An error thrown in the main process reaches the page as "Error invoking
 * remote method 'media:relink': Error: <message>"; the message is already a
 * sentence in the interface language (main/language.ts), and the wrapper is
 * noise, so it goes.
 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
}
