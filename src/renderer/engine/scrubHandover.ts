/**
 * Which forward decoders a draw keeps, and which it hands on.
 *
 * The decoders are kept per clip, but everything a decoder holds - where it is
 * and the small pictures it kept on the way - is a position in the FILE, not
 * in the clip. A cut, a paste or an undo gives the clip under the playhead a
 * new id while it still shows the same file, and keying by id alone threw
 * that decoder away and started an empty one: every frame a drag had just
 * covered had to be decoded again.
 *
 * So a decoder whose clip is gone goes to a wanted clip of the same file that
 * has none yet, and is closed only when there is no such clip. A clip that now
 * points at a different file never inherits: the kept pictures would be of
 * the wrong video.
 *
 * Pure apart from `close`, so it is tested directly.
 */

export interface HandableScrubber {
  readonly sourceUri: string;
  close(): void;
}

/**
 * Keep the decoders in `wanted` (key to source URI), hand the rest to a
 * wanted key of the same file that has none, and close whatever is left.
 */
export function keepScrubbers<Scrubber extends HandableScrubber>(
  scrubbers: Map<string, Scrubber>,
  wanted: ReadonlyMap<string, string>,
): void {
  for (const [key, scrubber] of [...scrubbers]) {
    if (wanted.has(key)) continue;
    scrubbers.delete(key);

    let heir: string | null = null;
    for (const [candidate, sourceUri] of wanted) {
      if (sourceUri === scrubber.sourceUri && !scrubbers.has(candidate)) {
        heir = candidate;
        break;
      }
    }

    if (heir === null) scrubber.close();
    else scrubbers.set(heir, scrubber);
  }
}
