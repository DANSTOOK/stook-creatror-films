import { useEffect, useRef } from 'react';
import type { MediaAsset } from '@shared/types';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { Filmstrip, parsePeaksFile, parseThumbsFile } from './clipContent';

/** Whether the main process makes waveforms and filmstrips (it does under Electron). */
export const mainMakesClipContent = (): boolean =>
  typeof window !== 'undefined' && typeof window.filmora?.contentPeaks === 'function';

async function readArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * Ask the main process for every file's waveform and filmstrip, once each.
 *
 * Nothing waits on these: the timeline draws a clip in its colour until its
 * pictures arrive, and a file already measured in an earlier session comes
 * straight from the disk cache. Keyed by the asset's URI, which is what clips
 * point at; a relinked file has a new URI and so is asked for again.
 */
export function useClipContent(): void {
  const assets = useProjectStore((state) => state.assets);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!mainMakesClipContent()) return;
    const wanted = (asset: MediaAsset): boolean => !asset.missing && Boolean(asset.sourcePath) && !requested.current.has(asset.uri);

    for (const asset of assets.filter(wanted)) {
      requested.current.add(asset.uri);
      const path = asset.sourcePath as string;
      const seconds = asset.durationSeconds ?? 0;

      if (asset.kind !== 'image') {
        void window.filmora.contentPeaks?.(path, seconds)
          .then(async (url) => {
            const buffer = url ? await readArrayBuffer(url) : null;
            const peaks = buffer ? parsePeaksFile(buffer) : null;
            if (peaks) useMediaStore.getState().setWaveform(asset.uri, peaks);
          })
          .catch(() => undefined);
      }
      if (asset.kind !== 'audio') {
        void window.filmora.contentThumbs?.(path, asset.kind === 'image' ? 'image' : 'video', seconds)
          .then(async (url) => {
            const buffer = url ? await readArrayBuffer(url) : null;
            const index = buffer ? parseThumbsFile(buffer) : null;
            if (!index) return;
            const media = useMediaStore.getState();
            media.setFilmstrip(asset.uri, new Filmstrip(index, () => useMediaStore.getState().contentChanged()));
          })
          .catch(() => undefined);
      }
    }
  }, [assets]);
}
