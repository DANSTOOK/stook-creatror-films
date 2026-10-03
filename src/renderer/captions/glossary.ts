import type { Clip } from '@shared/types';

/**
 * A project's glossary: the names and terms it says, spelled as they should
 * be written - people, places, brands, words made up for the video.
 *
 * It is used twice. Whisper is given it as its initial prompt (`--prompt`):
 * text it takes as having been said just before, which leans its spelling
 * towards those words when it hears something like them. And afterwards
 * what it wrote is searched for words one letter away from a term - "Stuk"
 * for "Stook" - which are offered as a replace-everywhere.
 *
 * Whether the prompt helps is measured, not assumed: see
 * tests/bench/captions-glossary.mjs and the CHANGELOG.
 */

/** Terms kept, and how long each may be. */
export const MAX_TERMS = 100;
export const MAX_TERM_LENGTH = 60;
/**
 * Whisper reads at most 224 tokens of prompt; past that it keeps the end.
 * A few hundred characters stays well inside that for any language.
 */
export const MAX_PROMPT_LENGTH = 600;

/** Terms as typed - one a line, or separated by commas - tidied: trimmed, no empties, no repeats. */
export function normalizeGlossary(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,;]+/) : [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    // Nothing that is not a letter, digit, space or ordinary punctuation of a name.
    const term = item
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TERM_LENGTH)
      .trim();
    const key = term.toLowerCase();
    if (term === '' || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/**
 * The prompt Whisper is given: the terms as a list, the way a sentence that
 * names them would write them. Empty when there are none. As many as fit
 * MAX_PROMPT_LENGTH, from the first.
 */
export function glossaryPrompt(terms: readonly string[]): string {
  let prompt = '';
  for (const term of normalizeGlossary(terms)) {
    const next = prompt === '' ? term : `${prompt}, ${term}`;
    if (next.length + 1 > MAX_PROMPT_LENGTH) break;
    prompt = next;
  }
  return prompt === '' ? '' : `${prompt}.`;
}

/** For comparing spellings: no case, no accents, letters and digits only. */
export const foldWord = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Edits from one to the other - a letter put in, taken out, changed, or two swapped - stopping past `limit`. */
export function editDistance(a: string, b: string, limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i][j] = value;
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
  }
  return rows[a.length][b.length];
}

/** Too short to tell from an ordinary word one letter away: "Ana" and "una". */
const MIN_LETTERS = 4;

export interface GlossarySuggestion {
  /** The term, as it should be written. */
  term: string;
  /** What was written instead, exactly as it is in the captions. */
  found: string;
  /** How many times. */
  count: number;
  /** The captions it is in. */
  clipIds: string[];
}

const piecesOf = (text: string): string[] => text.split(/\s+/).filter((piece) => piece !== '');
/** A piece without the punctuation around it: what is replaced. */
const bare = (piece: string): string => piece.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Words in these captions that are a glossary term misspelt by one edit -
 * or spelt the same but for case or accents - grouped by how they were
 * written. A term of several words is looked for as that many words in a row.
 */
export function glossarySuggestions(captions: readonly Pick<Clip, 'id' | 'caption'>[], terms: readonly string[]): GlossarySuggestion[] {
  const found = new Map<string, GlossarySuggestion>();
  const list = normalizeGlossary(terms).map((term) => ({ term, words: piecesOf(term).length, folded: foldWord(term) }));
  if (list.length === 0) return [];
  for (const caption of captions) {
    const pieces = piecesOf(caption.caption?.text ?? '');
    for (const { term, words, folded } of list) {
      if (folded.length < MIN_LETTERS) continue;
      for (let at = 0; at + words <= pieces.length; at += 1) {
        const run = pieces.slice(at, at + words);
        const written = [bare(run[0]), ...run.slice(1, -1), ...(words > 1 ? [bare(run[run.length - 1])] : [])].join(' ');
        if (written === term) continue;
        const distance = editDistance(foldWord(written), folded, 1);
        if (distance > 1) continue;
        // A name one letter from a word written in small letters is most
        // likely that word: "para" is not a misspelt "Mara".
        if (distance === 1 && /^\p{Lu}/u.test(term) && /^\p{Ll}/u.test(written)) continue;
        // Spelt as the term already, but for its case or accents - or one edit away.
        const key = `${term}\u0000${written}`;
        const entry = found.get(key) ?? { term, found: written, count: 0, clipIds: [] };
        entry.count += 1;
        if (!entry.clipIds.includes(caption.id)) entry.clipIds.push(caption.id);
        found.set(key, entry);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}
