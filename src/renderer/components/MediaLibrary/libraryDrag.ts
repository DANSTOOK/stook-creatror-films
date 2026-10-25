import { create } from 'zustand';

/**
 * What is being dragged out of the library, while it is: a title, a
 * transition or an effect - or a clip out of the media panel (`asset`).
 *
 * A drag's data cannot be read until the drop, and the timeline hears
 * nothing until the pointer reaches it - but it should show where a
 * transition can go from the moment one is picked up, as Final Cut lights
 * the edit points. So the panel says here what it has started dragging.
 */

export type LibraryDragKind = 'title' | 'transition' | 'effect';

/** Drag payload types: custom, so a drop into a text field does nothing. */
export const TITLE_DRAG_TYPE = 'application/x-scf-title';
export const TRANSITION_DRAG_TYPE = 'application/x-scf-transition';
/** An effect or a move from the Effects panel, as `effect:<type>` or `motion:<preset>`. */
export const EFFECT_DRAG_TYPE = 'application/x-scf-effect';

interface LibraryDragState {
  dragging: LibraryDragKind | null;
  setDragging(kind: LibraryDragKind | null): void;
  /** A clip being dragged out of the media panel: its asset's id. */
  asset: string | null;
  setAsset(assetId: string | null): void;
}

export const useLibraryDragStore = create<LibraryDragState>((set) => ({
  dragging: null,
  setDragging(dragging) {
    set({ dragging });
  },
  asset: null,
  setAsset(asset) {
    set({ asset });
  },
}));

/** Which library item a drag carries, from its types (readable during dragover). */
export function libraryDragKind(types: readonly string[]): LibraryDragKind | null {
  if (types.includes(TITLE_DRAG_TYPE)) return 'title';
  if (types.includes(TRANSITION_DRAG_TYPE)) return 'transition';
  if (types.includes(EFFECT_DRAG_TYPE)) return 'effect';
  return null;
}
