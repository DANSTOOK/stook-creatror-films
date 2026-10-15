import { create } from 'zustand';

/**
 * The LUTs this machine has to hand.
 *
 * Loading a look meant finding the .cube file again for every clip, through
 * the file dialog, from wherever the pack was unzipped. A grade is applied
 * across a whole sequence, so that is the same hunt a dozen times for one
 * look. Resolve keeps LUTs in a list, Premiere keeps the recent ones in the
 * Lumetri dropdown; this is that list.
 *
 * It holds names and paths, not the files themselves: the .cube stays where
 * it is on disk, the same path a project saves (`lutSourcePath`), so a look
 * remembered here and a look saved in a project mean the same file. A path
 * that no longer exists reports its error when it is used, which is the
 * moment anyone can do something about it.
 *
 * A setting of this machine, not of a project - where somebody keeps their
 * LUT packs is not part of the edit - so it lives in localStorage beside the
 * panel sizes and the language.
 */

export interface LibraryLut {
  /** The path, which is also the identity: the same file twice is one entry. */
  path: string;
  /** The file's name, as the inspector shows it. */
  name: string;
  /** ISO time it was last applied, so the list can be most-recent first. */
  used: string;
}

/** Enough for a pack or two, and short enough to read. */
export const LIBRARY_LIMIT = 40;

const STORAGE_KEY = 'scf.lutLibrary';

/** Windows paths differ only in case or slash and are the same file. */
const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** One entry, or nothing if the stored shape is not one. */
function readEntry(value: unknown): LibraryLut | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== 'string' || entry.path === '') return null;
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : (entry.path.split(/[\\/]/).pop() ?? entry.path);
  const used = typeof entry.used === 'string' ? entry.used : new Date(0).toISOString();
  return { path: entry.path, name, used };
}

export function load(): LibraryLut[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: LibraryLut[] = [];
    for (const value of parsed) {
      const entry = readEntry(value);
      // A file listed twice would apply the same look from two rows.
      if (entry && !entries.some((kept) => samePath(kept.path, entry.path))) entries.push(entry);
    }
    // The order written is the order meant - most recently used first - so
    // it is kept as it is rather than sorted by a timestamp that several
    // entries can share.
    return entries.slice(0, LIBRARY_LIMIT);
  } catch {
    // A library that cannot be read is an empty one, not a broken editor.
    return [];
  }
}

function save(luts: readonly LibraryLut[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(luts));
  } catch {
    // A list that cannot be remembered still works for this session.
  }
}

interface LutLibraryState {
  luts: LibraryLut[];
  /**
   * Keep a look that was just applied, or move it back to the top.
   *
   * Called wherever a LUT is loaded from a path, so the library fills itself
   * as somebody works instead of having to be curated.
   */
  remember(path: string, name?: string): void;
  /** Take one off the list. The file on disk is not touched. */
  forget(path: string): void;
  clear(): void;
}

export const useLutLibrary = create<LutLibraryState>((set, get) => ({
  luts: load(),

  remember(path, name) {
    if (path === '') return;
    const entry: LibraryLut = {
      path,
      name: name && name !== '' ? name : (path.split(/[\\/]/).pop() ?? path),
      used: new Date().toISOString(),
    };
    // Straight to the front, and the oldest off the end: a look just used
    // must never be the one the limit drops.
    const luts = [entry, ...get().luts.filter((lut) => !samePath(lut.path, path))].slice(0, LIBRARY_LIMIT);
    set({ luts });
    save(luts);
  },

  forget(path) {
    const luts = get().luts.filter((lut) => !samePath(lut.path, path));
    set({ luts });
    save(luts);
  },

  clear() {
    set({ luts: [] });
    save([]);
  },
}));
