import { create } from 'zustand';

/**
 * Whether the "Remove silences" dialog is open, and for which clip. Opened
 * from a clip's context menu on the timeline and from the inspector's Audio
 * tab; the clip is kept while the dialog plays its exit, so it does not empty
 * as it goes.
 */
interface SilenceDialogState {
  open: boolean;
  clipId: string | null;
  show(clipId: string): void;
  close(): void;
}

export const useSilenceDialogStore = create<SilenceDialogState>((set) => ({
  open: false,
  clipId: null,
  show(clipId) {
    set({ open: true, clipId });
  },
  close() {
    set({ open: false });
  },
}));
