import { create } from 'zustand';
import { PREVIEW_QUALITIES, type PreviewQuality } from '@renderer/engine/previewSize';

/** The viewer's playback resolution (engine/previewSize.ts), kept between sessions. */

const KEY = 'scf.previewQuality';

function saved(): PreviewQuality {
  try {
    const value = window.localStorage.getItem(KEY);
    return PREVIEW_QUALITIES.includes(value as PreviewQuality) ? (value as PreviewQuality) : 'auto';
  } catch {
    return 'auto';
  }
}

export const usePreviewQuality = create<{ quality: PreviewQuality; setQuality(quality: PreviewQuality): void }>((set) => ({
  quality: typeof window === 'undefined' ? 'auto' : saved(),
  setQuality(quality) {
    set({ quality });
    try {
      window.localStorage.setItem(KEY, quality);
    } catch {
      // Not kept: it applies for this session.
    }
  },
}));
