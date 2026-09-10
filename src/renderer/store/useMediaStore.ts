import { create } from 'zustand';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';

/**
 * Runtime media caches: decoded waveform peaks, and which assets are still
 * being analysed.
 *
 * These are deliberately NOT part of the project document. Peaks are derived
 * data (a `Float32Array` that would bloat a save file and go stale anyway), so
 * they live in their own store and are recomputed on import.
 */

interface MediaState {
  waveforms: Record<string, WaveformPeaks>;
  analysing: string[];

  setWaveform(uri: string, peaks: WaveformPeaks): void;
  beginAnalysis(uri: string): void;
  endAnalysis(uri: string): void;
  clear(): void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  waveforms: {},
  analysing: [],

  setWaveform(uri, peaks) {
    set({ waveforms: { ...get().waveforms, [uri]: peaks } });
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
    set({ waveforms: {}, analysing: [] });
  },
}));
