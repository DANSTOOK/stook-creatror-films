/**
 * A script cut into pieces one request can speak, and the pace a slider may
 * ask for.
 *
 * This used to be part of the file that found and ran Piper's and Kokoro's
 * programs on this computer (`engine.ts`). Those engines are gone - Azure's
 * voices are the only ones now - but the splitting is not about them: Azure
 * takes at most a few thousand characters of SSML per request, progress can
 * only be reported per piece, and a cancel lands at a piece boundary. So the
 * part that was never about a child process stayed, and the rest went.
 *
 * Nothing in here needs Electron, so the unit tests load it directly.
 */

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/**
 * A speed a slider can send, held to a range that stays intelligible. The
 * range is also exactly what Azure's `<prosody rate>` accepts (0.5-2x), so a
 * clamped speed is always a document the service will parse.
 */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/**
 * Long text, split into pieces of a sentence or a run of short ones. Each
 * piece is one request, so progress can be shown and a cancel lands quickly.
 * Splitting is by sentence end, then pieces are packed up to `maxChars` so
 * short sentences are not each their own round-trip.
 */
export function splitText(text: string, maxChars = 400): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const sentences = clean
    .split(/(?<=[.!?…。])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((sentence) => (sentence.length > maxChars ? splitLongSentence(sentence, maxChars) : [sentence]));
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= maxChars) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * A sentence longer than `maxChars` - a pasted paragraph with no full stop,
 * a list run together - in pieces no longer than that: at a comma, semicolon,
 * colon or dash where there is one, else between words. A single run of
 * thousands of characters would otherwise go out as one document, and a
 * voice's phrasing drifts over one that long.
 */
export function splitLongSentence(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const add = (part: string): void => {
    if (current && current.length + part.length + 1 > maxChars) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${part}` : part;
  };
  for (const clause of sentence.split(/(?<=[,;:])\s+|\s+(?=[—–-]\s)/)) {
    if (clause.length <= maxChars) {
      add(clause);
      continue;
    }
    for (const word of clause.split(' ')) {
      // A "word" longer than the budget (a URL, a run of symbols) is cut where it must be.
      for (let at = 0; at < word.length; at += maxChars) add(word.slice(at, at + maxChars));
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
