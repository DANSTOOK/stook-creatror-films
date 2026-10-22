import { create } from 'zustand';
import type { FrameBox } from './track';

/**
 * Which clip is having the thing it follows marked, and the box marked so
 * far. The inspector's Effects tab starts it ("Mark the object") and the
 * viewer draws the box over the picture for as long as it is set
 * (PreviewViewport/TrackBoxOverlay).
 */
interface TrackEditState {
  clipId: string | null;
  box: FrameBox;
  start(clipId: string, box: FrameBox): void;
  stop(): void;
  setBox(box: FrameBox): void;
}

export const useTrackEditStore = create<TrackEditState>((set) => ({
  clipId: null,
  box: { x: 0.5, y: 0.5, width: 0.15, height: 0.15 },
  start(clipId, box) {
    set({ clipId, box });
  },
  stop() {
    set({ clipId: null });
  },
  setBox(box) {
    set({ box });
  },
}));
