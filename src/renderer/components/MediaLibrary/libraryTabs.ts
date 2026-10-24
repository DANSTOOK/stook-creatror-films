/**
 * Asking the Library panel to show one of its tabs, from anywhere.
 *
 * New captions bring their list forward, the way a new title selects
 * itself: the thing just made is the thing to look at. An event rather than
 * shared state, because which tab is open is the panel's own business (and
 * remembered by it); this only knocks.
 */
export const LIBRARY_TAB_EVENT = 'scf:library-tab';

export type LibraryTab = 'media' | 'titles' | 'transitions' | 'effects' | 'stickers' | 'sounds' | 'voice' | 'captions';

/**
 * The tab asked for last, until the panel takes it: a panel put away (the
 * Color workspace hides the library) is not there to hear the knock, and
 * opens on it when it comes back.
 */
let requested: LibraryTab | null = null;

export function showLibraryTab(tab: LibraryTab): void {
  requested = tab;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LIBRARY_TAB_EVENT, { detail: tab }));
}

/** The tab asked for while the panel was away, once. */
export function takeRequestedLibraryTab(): LibraryTab | null {
  const tab = requested;
  requested = null;
  return tab;
}
