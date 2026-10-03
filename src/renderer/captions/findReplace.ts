/**
 * Find and replace across captions.
 *
 * What is searched is what is read: a phrase that runs over a line break is
 * still found, so the space between two words matches a space or a break.
 * Case is ignored unless asked for, and so is nothing else - an accent is a
 * different letter ("si" does not find "sí"), because replacing one for the
 * other is exactly the kind of correction this is used for.
 */

export interface FindOptions {
  matchCase?: boolean;
  /** Only where the query is a whole word (or words): "Ana" not inside "Anabel". */
  wholeWord?: boolean;
}

export interface CaptionMatch {
  clipId: string;
  /** Which match inside that caption, from 0. */
  occurrence: number;
  /** Where it starts in the caption's text, and how long it is. */
  index: number;
  length: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for a query, or null for an empty one (which matches nothing, not everything). */
export function findPattern(query: string, options: FindOptions = {}): RegExp | null {
  if (query.trim() === '') return null;
  const body = query
    .split(/\s+/)
    .filter((part) => part !== '')
    .map(escapeRegExp)
    .join('\\s+');
  const bounded = options.wholeWord ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body;
  return new RegExp(bounded, options.matchCase ? 'gu' : 'giu');
}

/** Every match, caption by caption in the order given. */
export function findInCaptions(captions: ReadonlyArray<{ id: string; text: string }>, query: string, options: FindOptions = {}): CaptionMatch[] {
  const pattern = findPattern(query, options);
  if (!pattern) return [];
  const matches: CaptionMatch[] = [];
  for (const caption of captions) {
    pattern.lastIndex = 0;
    let occurrence = 0;
    for (let found = pattern.exec(caption.text); found !== null; found = pattern.exec(caption.text)) {
      matches.push({ clipId: caption.id, occurrence, index: found.index, length: found[0].length });
      occurrence += 1;
      // A match of no length would never move on.
      if (found[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return matches;
}

/**
 * A caption's text with the query replaced: every match, or only the
 * `occurrence`-th. The replacement is taken as written - a "$1" in it is a
 * dollar sign and a one. Returns the text and how many were replaced.
 */
export function replaceInText(text: string, query: string, replacement: string, options: FindOptions & { occurrence?: number } = {}): { text: string; count: number } {
  const pattern = findPattern(query, options);
  if (!pattern) return { text, count: 0 };
  let seen = 0;
  let count = 0;
  const replaced = text.replace(pattern, (match) => {
    const mine = options.occurrence === undefined || options.occurrence === seen;
    seen += 1;
    if (!mine) return match;
    count += 1;
    return replacement;
  });
  return { text: replaced, count };
}
