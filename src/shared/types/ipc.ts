import type { ExportProgress, ExportSettings, HardwareEncoder, MediaKind } from './index';

/** Channel names shared by the main process and the preload bridge. */
export const IPC = {
  openMedia: 'dialog:open-media',
  openProject: 'dialog:open-project',
  saveProjectAs: 'dialog:save-project-as',
  chooseExportPath: 'dialog:choose-export-path',
  readFile: 'fs:read-file',
  readTextFile: 'fs:read-text-file',
  writeTextFile: 'fs:write-text-file',
  probeMedia: 'media:probe',
  detectEncoders: 'export:detect-encoders',
  exportStart: 'export:start',
  exportFrame: 'export:frame',
  exportFinish: 'export:finish',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
} as const;

export interface PickedFile {
  path: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
}

export interface MediaProbe {
  path: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAlphaChannel: boolean;
  hasAudio: boolean;
  codec: string;
}

export interface ExportStartResult {
  jobId: string;
}

/**
 * The surface exposed on `window.filmora` by the preload script.
 *
 * Everything is promise-based and takes plain structured-cloneable data, so no
 * Node primitive ever leaks into the renderer.
 */
export interface FilmoraApi {
  openMedia(): Promise<PickedFile[]>;
  openProject(): Promise<{ path: string; contents: string } | null>;
  saveProjectAs(contents: string, suggestedName?: string): Promise<string | null>;
  chooseExportPath(format: ExportSettings['format']): Promise<string | null>;

  readFile(path: string): Promise<ArrayBuffer>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;

  probeMedia(path: string): Promise<MediaProbe>;
  detectEncoders(): Promise<HardwareEncoder[]>;

  /** Open an encoder and start accepting frames. */
  exportStart(settings: ExportSettings): Promise<ExportStartResult>;
  /** Push one straight-alpha RGBA frame (top-down rows). */
  exportFrame(jobId: string, rgba: ArrayBuffer): Promise<void>;
  /** Close stdin and wait for the encoder to flush. */
  exportFinish(jobId: string): Promise<void>;
  exportCancel(jobId: string): Promise<void>;

  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
}

declare global {
  interface Window {
    filmora: FilmoraApi;
  }
}
