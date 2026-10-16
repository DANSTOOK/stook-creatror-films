import { useEffect } from 'react';
import { create } from 'zustand';
import type { MediaAsset, MatteModelId } from '@shared/types';
import type { MatteEngineStatus } from '@shared/types/ipc';
import type { MessageKey } from '@shared/i18n';
import { t } from '@renderer/i18n';
import { errorText } from '@renderer/errorText';
import { notify } from '@renderer/notifications/notifications';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Remove background, as the page knows it: which models are on this
 * computer, which files have been analysed, and the analysis running now.
 *
 * Mattes belong to a file and a model, not to a clip: two clips cut from
 * one file share them, and they live in a cache in the main process (see
 * main/matting/matteStore.ts), found again by the file's path, size and
 * modification time - a file changed on disk is analysed afresh.
 *
 * A model is downloaded only from `download`, and `download` is only called
 * from the permission prompt (components/Inspector/MatteModelPrompt) once
 * the person has pressed Download there.
 */

export const MATTE_MODEL_NAME: Record<MatteModelId, MessageKey> = {
  precise: 'mattes.namePrecise',
  fast: 'mattes.nameFast',
};

export interface MatteJobState {
  done: number;
  total: number;
  msPerFrame: number;
  device: 'gpu' | 'cpu' | null;
}

interface MattesState {
  status: MatteEngineStatus | null;
  downloading: { id: MatteModelId; received: number; total: number } | null;
  /**
   * The mattes' URL by `path|model`: null when that file has none for that
   * model, absent when nobody has asked yet. The URL carries a revision, so
   * mattes deleted and made again are never read from what the renderer
   * kept of the old ones.
   */
  urls: Record<string, string | null>;
  jobs: Record<string, MatteJobState>;
  errors: Record<string, string>;
  refresh(): Promise<MatteEngineStatus | null>;
  download(id: MatteModelId): Promise<boolean>;
  cancelDownload(): void;
  lookup(path: string, model: MatteModelId): Promise<void>;
  analyse(asset: MediaAsset, model: MatteModelId): Promise<void>;
  cancel(path: string, model: MatteModelId): void;
  remove(path: string, model: MatteModelId): Promise<void>;
}

export const matteEntry = (path: string, model: MatteModelId): string => `${path}|${model}`;

const bridge = (): typeof window.filmora | null => (typeof window !== 'undefined' && window.filmora?.mattesStatus ? window.filmora : null);

let revision = 0;
const withRevision = (url: string | null): string | null => (url ? `${url}?v=${(revision += 1)}` : null);

let listening = false;
function listen(): void {
  const api = bridge();
  if (listening || !api) return;
  listening = true;
  api.onMatteModelProgress?.((progress) => {
    if (useMattes.getState().downloading?.id === progress.id) useMattes.setState({ downloading: progress });
  });
  api.onMatteProgress?.((progress) => {
    const entry = matteEntry(progress.path, progress.model);
    useMattes.setState((state) => ({
      jobs: { ...state.jobs, [entry]: { done: progress.done, total: progress.total, msPerFrame: progress.msPerFrame, device: progress.device } },
    }));
  });
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  void _gone;
  return rest;
};

export const useMattes = create<MattesState>((set, get) => ({
  status: null,
  downloading: null,
  urls: {},
  jobs: {},
  errors: {},

  async refresh() {
    const api = bridge();
    if (!api?.mattesStatus) return null;
    listen();
    const status = await api.mattesStatus();
    set({ status });
    return status;
  },

  async download(id) {
    const api = bridge();
    if (!api?.mattesModelDownload || get().downloading) return false;
    listen();
    const size = get().status?.models.find((model) => model.id === id)?.bytes ?? 0;
    set({ downloading: { id, received: 0, total: size } });
    try {
      const status = await api.mattesModelDownload(id);
      set({ status, downloading: null });
      const ready = status.models.find((model) => model.id === id)?.present === true;
      if (ready) notify(t('mattes.modelDownloaded', { name: t(MATTE_MODEL_NAME[id]) }), 'success');
      return ready;
    } catch (error) {
      set({ downloading: null });
      notify(errorText(error), 'error');
      void get().refresh();
      return false;
    }
  },

  cancelDownload() {
    const current = get().downloading;
    if (current) void bridge()?.mattesModelCancel?.(current.id);
  },

  async lookup(path, model) {
    const api = bridge();
    if (!api?.mattesFind) return;
    const entry = matteEntry(path, model);
    const url = await api.mattesFind(path, model).catch(() => null);
    set((state) => ({ urls: { ...state.urls, [entry]: withRevision(url) } }));
  },

  async analyse(asset, model) {
    const api = bridge();
    const path = asset.sourcePath;
    if (!api?.mattesBuild || !path) return;
    listen();
    const entry = matteEntry(path, model);
    if (get().jobs[entry]) return;
    set((state) => ({ jobs: { ...state.jobs, [entry]: { done: 0, total: 0, msPerFrame: 0, device: null } }, errors: without(state.errors, entry) }));
    try {
      const url = await api.mattesBuild({
        path,
        model,
        width: asset.width,
        height: asset.height,
        fps: asset.sourceFps ?? 0,
        seconds: asset.durationSeconds ?? 0,
        still: asset.kind === 'image',
      });
      set((state) => ({ urls: { ...state.urls, [entry]: withRevision(url) } }));
    } catch (error) {
      set((state) => ({ errors: { ...state.errors, [entry]: errorText(error) } }));
    } finally {
      set((state) => ({ jobs: without(state.jobs, entry) }));
      void get().refresh();
    }
  },

  cancel(path, model) {
    void bridge()?.mattesCancel?.(path, model);
  },

  async remove(path, model) {
    const api = bridge();
    if (!api?.mattesDelete) return;
    await api.mattesDelete(path, model);
    set((state) => ({ urls: { ...state.urls, [matteEntry(path, model)]: null } }));
  },
}));

/** The mattes to draw a file with, for the renderer: null until they exist. */
export const matteUrlFor = (path: string, model: MatteModelId): string | null => useMattes.getState().urls[matteEntry(path, model)] ?? null;

/**
 * Find the mattes of every clip that has Remove background on, whether or
 * not the inspector has shown it: a project reopened today draws, and
 * exports, with the mattes analysed yesterday.
 */
export function useMatteLookups(): void {
  const clips = useProjectStore((state) => state.project.clips);
  const assets = useProjectStore((state) => state.assets);
  useEffect(() => {
    if (!bridge()) return;
    const byUri = new Map(assets.map((asset) => [asset.uri, asset]));
    const known = useMattes.getState().urls;
    for (const clip of Object.values(clips)) {
      if (!clip.backgroundRemoval?.enabled) continue;
      const path = byUri.get(clip.sourceUri)?.sourcePath;
      if (!path) continue;
      const entry = matteEntry(path, clip.backgroundRemoval.model);
      if (entry in known) continue;
      void useMattes.getState().lookup(path, clip.backgroundRemoval.model);
    }
  }, [clips, assets]);
}
