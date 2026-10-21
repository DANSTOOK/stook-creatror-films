import { create } from 'zustand';

/**
 * Which clip's zoom zone is being picked in the viewer, if any. The
 * inspector's Effects tab starts it ("Pick the zone in the viewer") and the
 * viewer draws the zone over the picture for as long as it is set
 * (PreviewViewport/ZoomZoneOverlay).
 */
interface ZoneEditState {
  clipId: string | null;
  setClipId(clipId: string | null): void;
}

export const useZoneEditStore = create<ZoneEditState>((set) => ({
  clipId: null,
  setClipId(clipId) {
    set({ clipId });
  },
}));

/** Bring the inspector to a clip's Effects tab, as a drop or a click from the library does. */
export const SHOW_CLIP_FX_EVENT = 'scf:show-clip-fx';
