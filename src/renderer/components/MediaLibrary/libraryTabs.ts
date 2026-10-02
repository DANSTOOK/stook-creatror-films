/**
 * Asking the Library panel to show one of its tabs, from anywhere.
 *
 * New captions bring their list forward, the way a new title selects
 * itself: the thing just made is the thing to look at. An event rather than
 * shared state, because which tab is open is the panel's own business (and
 * remembered by it); this only knocks.
 */
export const LIBRARY_TAB_EVENT = 'scf:library-tab';

export type LibraryTab = 'media' | 'titles' | 'transitions' | 'captions';

export function showLibraryTab(tab: LibraryTab): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LIBRARY_TAB_EVENT, { detail: tab }));
}
