import { useCallback, useEffect, useState } from 'react';

import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { PROXY_STORAGE_KEY, pendingProxies, wantsProxy } from './proxyState';
import type { MediaAsset } from '@shared/types';

/**
 * Building proxies, and the switch that says whether to use them.
 *
 * The switch is a preference about this machine, not about the project - the
 * same edit on a faster computer does not want the same answer - so it lives
 * in localStorage beside the panel sizes, and defaults to on: somebody who has
 * gone to the trouble of building proxies wants them used.
 *
 * Building is one file at a time. Two ffmpeg encodes on the same machine as a
 * running editor is how you make the editor stutter, which is the thing
 * proxies exist to prevent.
 */

let enabled = readEnabled();
const listeners = new Set<(on: boolean) => void>();

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(PROXY_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function proxiesEnabled(): boolean {
  return enabled;
}

export function setProxiesEnabled(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(PROXY_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // A blocked store just means the choice lasts for this session.
  }
  getActiveFrameRenderer()?.useProxies(on);
  for (const listener of listeners) listener(on);
}

export function useProxiesEnabled(): [boolean, (on: boolean) => void] {
  const [value, setValue] = useState(enabled);
  useEffect(() => {
    listeners.add(setValue);
    // The renderer may have been created after the last change was made.
    getActiveFrameRenderer()?.useProxies(enabled);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return [value, setProxiesEnabled];
}

export interface ProxyController {
  /** Progress of the builds running now, by asset id. */
  building: ReadonlyMap<string, number>;
  /** Build proxies for everything heavy that has none. */
  buildAll(): Promise<void>;
  /** Stop building. What is finished stays. */
  cancel(): void;
  busy: boolean;
}

export function useProxies(): ProxyController {
  const assets = useProjectStore((state) => state.assets);
  const [building, setBuilding] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);

  // A proxy built in an earlier session is still on disk: find it and use it,
  // rather than encoding the same file again every time the app starts.
  useEffect(() => {
    if (!hasNativeBridge()) return;
    const missing = assets.filter((asset) => wantsProxy(asset) && !asset.proxyUri && asset.sourcePath);
    if (missing.length === 0) return;

    let live = true;
    void (async () => {
      for (const asset of missing) {
        const found = await window.filmora.proxiesFind(asset.sourcePath as string).catch(() => null);
        if (!live || !found) continue;
        useProjectStore.getState().setAssetProxy(asset.id, found);
      }
    })();
    return () => {
      live = false;
    };
  }, [assets]);

  // Progress comes from the main process, which is where ffmpeg runs.
  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    return window.filmora.onProxyProgress(({ path, fraction }) => {
      const asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path);
      if (!asset) return;
      setBuilding((current) => new Map(current).set(asset.id, fraction));
    });
  }, []);

  const buildAll = useCallback(async () => {
    if (!hasNativeBridge() || busy) return;
    const queue = pendingProxies(useProjectStore.getState().assets).filter(
      (asset): asset is MediaAsset & { sourcePath: string } => Boolean(asset.sourcePath),
    );
    if (queue.length === 0) return;

    setBusy(true);
    try {
      // One at a time: a second encode would take the machine away from the
      // editor these are meant to keep responsive.
      for (const asset of queue) {
        setBuilding((current) => new Map(current).set(asset.id, 0));
        const url = await window.filmora
          .proxiesBuild(asset.sourcePath, asset.width, asset.height, asset.durationSeconds ?? 0)
          .catch(() => null);
        setBuilding((current) => {
          const next = new Map(current);
          next.delete(asset.id);
          return next;
        });
        if (url) useProjectStore.getState().setAssetProxy(asset.id, url);
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const cancel = useCallback(() => {
    if (!hasNativeBridge()) return;
    void window.filmora.proxiesCancel().catch(() => undefined);
  }, []);

  return { building, buildAll, cancel, busy };
}
