import { create } from 'zustand';
import type { CaptionEngineStatus, CaptionModelId } from '@shared/types/ipc';
import type { MessageKey } from '@shared/i18n';
import { t } from '@renderer/i18n';
import { errorText } from '@renderer/errorText';
import { notify } from '@renderer/notifications/notifications';

/**
 * The speech models, as the page knows them: which are on this computer,
 * and a download in progress.
 *
 * A model is downloaded only from `download`, and `download` is only called
 * from the permission prompt (ModelDownloadPrompt) once the person has
 * pressed Download there. Nothing fetches a model on its own.
 */

export const MODEL_NAME: Record<CaptionModelId, MessageKey> = {
  precise: 'captions.modelPrecise',
  fast: 'captions.modelFast',
};

/** The model a new transcription starts on: the accurate one. */
export const DEFAULT_MODEL: CaptionModelId = 'precise';

interface ModelsState {
  status: CaptionEngineStatus | null;
  /** The model being downloaded, and how far along, or null. */
  downloading: { id: CaptionModelId; received: number; total: number } | null;
  refresh(): Promise<CaptionEngineStatus | null>;
  /** Resolves true when the model is on this computer afterwards. */
  download(id: CaptionModelId): Promise<boolean>;
  cancelDownload(): void;
  /** Resolves with the model imported, or null when nothing was. */
  importFromFile(): Promise<boolean>;
  remove(id: CaptionModelId): Promise<void>;
}

const bridge = (): typeof window.filmora | null => (typeof window !== 'undefined' && window.filmora?.captionsStatus ? window.filmora : null);

let listening = false;

export const useCaptionModels = create<ModelsState>((set, get) => ({
  status: null,
  downloading: null,

  async refresh() {
    const api = bridge();
    if (!api?.captionsStatus) return null;
    const status = await api.captionsStatus();
    set({ status });
    return status;
  },

  async download(id) {
    const api = bridge();
    if (!api?.captionsModelDownload || get().downloading) return false;
    if (!listening && api.onCaptionModelProgress) {
      listening = true;
      api.onCaptionModelProgress((progress) => {
        if (get().downloading?.id === progress.id) set({ downloading: progress });
      });
    }
    const size = get().status?.models.find((model) => model.id === id)?.bytes ?? 0;
    set({ downloading: { id, received: 0, total: size } });
    try {
      const status = await api.captionsModelDownload(id);
      set({ status, downloading: null });
      const ready = status.models.find((model) => model.id === id)?.present === true;
      if (ready) notify(t('captions.modelDownloaded', { name: t(MODEL_NAME[id]) }), 'success');
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
    if (current) void bridge()?.captionsModelCancel?.(current.id);
  },

  async importFromFile() {
    const api = bridge();
    if (!api?.captionsModelImport) return false;
    try {
      const status = await api.captionsModelImport();
      if (!status) return false;
      set({ status });
      notify(t('captions.modelImported'), 'success');
      return true;
    } catch (error) {
      notify(errorText(error), 'error');
      return false;
    }
  },

  async remove(id) {
    const api = bridge();
    if (!api?.captionsModelDelete) return;
    set({ status: await api.captionsModelDelete(id) });
  },
}));

/** "574 MB": sizes as the download prompt and the list show them. */
export function formatBytes(bytes: number, locale: string): string {
  const megabytes = bytes / 1_000_000;
  return megabytes >= 1000
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(megabytes / 1000)} GB`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(megabytes)} MB`;
}
