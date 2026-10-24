import { useEffect, useState } from 'react';

import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { t } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { PROXY_STORAGE_KEY, pendingProxies, proxySuggestions, wantsProxy } from './proxyState';
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

/*
  The builds, for the whole app: one queue, whichever panel is showing. The
  chip in Media starts it, and so does the notice raised when heavy footage
  arrives, from wherever the import came - the media panel need not be open.
*/
interface BuildState {
  /** Progress of the builds running now, by asset id. */
  building: ReadonlyMap<string, number>;
  busy: boolean;
}

let builds: BuildState = { building: new Map(), busy: false };
const buildListeners = new Set<(state: BuildState) => void>();
/** Set by cancelProxies: the queue stops after the build it kills, not just that one build. */
let stopped = false;
let progressHeard = false;

function setBuilds(patch: Partial<BuildState>): void {
  builds = { ...builds, ...patch };
  for (const listener of buildListeners) listener(builds);
}

function setProgress(assetId: string, fraction: number | null): void {
  const next = new Map(builds.building);
  if (fraction === null) next.delete(assetId);
  else next.set(assetId, fraction);
  setBuilds({ building: next });
}

/** Build proxies for everything heavy that has none - or just for `only`, by asset id - one file at a time. */
export async function buildProxies(only?: readonly string[]): Promise<void> {
  if (!hasNativeBridge() || builds.busy) return;
  // Progress comes from the main process, which is where ffmpeg runs.
  if (!progressHeard) {
    progressHeard = true;
    window.filmora.onProxyProgress(({ path, fraction }) => {
      const asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path);
      // A last report after its build ended would bring a finished file back as building.
      if (asset && builds.building.has(asset.id)) setProgress(asset.id, fraction);
    });
  }
  const queue = pendingProxies(useProjectStore.getState().assets).filter(
    (asset): asset is MediaAsset & { sourcePath: string } => Boolean(asset.sourcePath) && (!only || only.includes(asset.id)),
  );
  if (queue.length === 0) return;

  stopped = false;
  setBuilds({ busy: true });
  try {
    // One at a time: a second encode would take the machine away from the
    // editor these are meant to keep responsive.
    for (const asset of queue) {
      if (stopped) break;
      setProgress(asset.id, 0);
      const url = await window.filmora
        .proxiesBuild(asset.sourcePath, asset.width, asset.height, asset.durationSeconds ?? 0)
        .catch(() => null);
      setProgress(asset.id, null);
      if (url) useProjectStore.getState().setAssetProxy(asset.id, url);
    }
  } finally {
    setBuilds({ busy: false });
  }
}

/** Stop building. What is finished stays. */
export function cancelProxies(): void {
  if (!hasNativeBridge()) return;
  stopped = true;
  void window.filmora.proxiesCancel().catch(() => undefined);
}

/** The files offered a proxy this session: each is offered once. */
const offered = new Set<string>();

/**
 * Offer proxies for heavy footage just imported, as a notice whose button
 * builds them: the chip in Media says as much, but a chip is easy to miss.
 * Not when proxies are switched off or already building, and not for a file
 * whose proxy is on disk from an earlier session - that one is just used.
 */
export async function suggestProxies(imported: readonly MediaAsset[]): Promise<void> {
  if (!hasNativeBridge() || !enabled || builds.busy) return;
  // As the library has them: an import of a file already there adds nothing new.
  const paths = new Set(imported.map((asset) => asset.sourcePath).filter((path): path is string => Boolean(path)));
  const candidates = proxySuggestions(useProjectStore.getState().assets).filter(
    (asset): asset is MediaAsset & { sourcePath: string } => Boolean(asset.sourcePath) && paths.has(asset.sourcePath as string) && !offered.has(asset.sourcePath as string),
  );
  const needed: MediaAsset[] = [];
  for (const asset of candidates) {
    offered.add(asset.sourcePath);
    const found = await window.filmora.proxiesFind(asset.sourcePath).catch(() => null);
    if (found) useProjectStore.getState().setAssetProxy(asset.id, found);
    else needed.push(asset);
  }
  if (needed.length === 0) return;
  notify(needed.length === 1 ? t('proxy.suggestOne', { name: needed[0].name }) : t('proxy.suggestMany', { count: needed.length }), 'info', {
    // The files it names, not every heavy one: the chip builds the rest.
    action: { label: t('proxy.suggestAction'), run: () => void buildProxies(needed.map((asset) => asset.id)) },
  });
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
  const [{ building, busy }, setState] = useState(builds);
  useEffect(() => {
    buildListeners.add(setState);
    // A build may have started or ended while this was not mounted.
    setState(builds);
    return () => {
      buildListeners.delete(setState);
    };
  }, []);

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

  return { building, buildAll: () => buildProxies(), cancel: cancelProxies, busy };
}
