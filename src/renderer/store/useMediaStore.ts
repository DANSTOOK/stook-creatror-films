import { create } from 'zustand';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import {
  loadClipAppearance,
  saveClipAppearance,
  type ClipAppearance,
  type Filmstrip,
} from '@renderer/media/clipContent';

/**
 * Runtime media caches: waveform peaks, filmstrips, and which assets are
 * still being analysed.
 *
 * These are deliberately NOT part of the project document. Peaks and
 * filmstrips are derived data that would bloat a save file and go stale
 * anyway; the main process keeps them on disk (main/media/clipContent.ts)
 * and they are read back here, by source URI, when a file comes in.
 */

interface MediaState {
  waveforms: Record<string, WaveformPeaks>;
  filmstrips: Record<string, Filmstrip>;
  analysing: string[];
  /** Bumped when a filmstrip frame has been decoded, so the timeline paints it. */
  contentVersion: number;
  /** What timeline clips show; a setting of this machine, like the panel sizes. */
  clipAppearance: ClipAppearance;

  setWaveform(uri: string, peaks: WaveformPeaks): void;
  setFilmstrip(uri: string, filmstrip: Filmstrip): void;
  contentChanged(): void;
  setClipAppearance(appearance: ClipAppearance): void;
  beginAnalysis(uri: string): void;
  endAnalysis(uri: string): void;
  clear(): void;
}

/** Frames arrive in bursts: one repaint for a burst, not one per frame. */
let bumpScheduled = false;

export const useMediaStore = create<MediaState>((set, get) => ({
  waveforms: {},
  filmstrips: {},
  analysing: [],
  contentVersion: 0,
  clipAppearance: typeof window === 'undefined' ? 'both' : loadClipAppearance(),

  setWaveform(uri, peaks) {
    set({ waveforms: { ...get().waveforms, [uri]: peaks } });
  },

  setFilmstrip(uri, filmstrip) {
    set({ filmstrips: { ...get().filmstrips, [uri]: filmstrip } });
  },

  contentChanged() {
    if (bumpScheduled) return;
    bumpScheduled = true;
    setTimeout(() => {
      bumpScheduled = false;
      set({ contentVersion: get().contentVersion + 1 });
    }, 32);
  },

  setClipAppearance(appearance) {
    saveClipAppearance(appearance);
    set({ clipAppearance: appearance });
  },

  beginAnalysis(uri) {
    const { analysing } = get();
    if (analysing.includes(uri)) return;
    set({ analysing: [...analysing, uri] });
  },

  endAnalysis(uri) {
    set({ analysing: get().analysing.filter((entry) => entry !== uri) });
  },

  clear() {
    set({ waveforms: {}, filmstrips: {}, analysing: [] });
  },
}));
