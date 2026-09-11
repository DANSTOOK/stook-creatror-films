import type {
  ExportProgress,
  ExportSettings,
  GpuPreference,
  GpuReport,
  HardwareEncoder,
  MediaKind,
} from './index';

/** Channel names shared by the main process and the preload bridge. */
export const IPC = {
  openMedia: 'dialog:open-media',
  registerDroppedFiles: 'drop:register-files',
  mediaUrl: 'media:url',
  extractAudio: 'media:extract-audio',
  openProject: 'dialog:open-project',
  openLut: 'dialog:open-lut',
  saveProjectAs: 'dialog:save-project-as',
  chooseExportPath: 'dialog:choose-export-path',
  chooseExportFolder: 'dialog:choose-export-folder',
  resolveExportTarget: 'export:resolve-target',
  chooseThumbnail: 'dialog:choose-thumbnail',
  writeThumbnail: 'export:write-thumbnail',
  readFile: 'fs:read-file',
  readTextFile: 'fs:read-text-file',
  writeTextFile: 'fs:write-text-file',
  probeMedia: 'media:probe',
  detectEncoders: 'export:detect-encoders',
  gpuReport: 'gpu:report',
  setGpuPreference: 'gpu:set-preference',
  relaunch: 'app:relaunch',
  writeExportAudio: 'export:write-audio',
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
  /**
   * Files dropped onto the window, resolved to their paths on disk and added
   * to the read allowlist - so a drop is as good as the open dialog: the
   * project can be saved and reopened, and ffmpeg can probe the exact rate.
   * Files with no path on disk are left out of the result.
   */
  registerDroppedFiles(files: File[]): Promise<PickedFile[]>;
  /** A `media://` URL that streams an allowlisted file from disk by ranges. */
  mediaUrl(path: string): Promise<string>;
  /**
   * The file's audio track alone, as a small `media://` file for decoding, or
   * null when there is none.
   */
  extractAudio(path: string): Promise<string | null>;
  openProject(): Promise<{ path: string; contents: string } | null>;
  /**
   * Pick a `.cube` LUT. Returns the path as well as the contents, because the
   * path is what lets the look survive saving and reopening the project.
   */
  openLut(): Promise<{ path: string; contents: string } | null>;
  saveProjectAs(contents: string, suggestedName?: string): Promise<string | null>;
  chooseExportPath(format: ExportSettings['format']): Promise<string | null>;
  /** Pick the folder an export is written into. */
  chooseExportFolder(): Promise<string | null>;
  /**
   * Join an allowlisted folder and a typed file name into the export target,
   * with the right extension, and say whether it already exists.
   */
  resolveExportTarget(
    folder: string,
    name: string,
    format: ExportSettings['format'],
  ): Promise<{ path: string; exists: boolean }>;
  /** Pick an image to use as the video's thumbnail. */
  chooseThumbnail(): Promise<string | null>;
  /** Store a PNG (e.g. the current frame) as a thumbnail and return its path. */
  writeThumbnail(png: ArrayBuffer): Promise<string>;

  readFile(path: string): Promise<ArrayBuffer>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;

  probeMedia(path: string): Promise<MediaProbe>;
  detectEncoders(): Promise<HardwareEncoder[]>;

  /** GPUs present, the saved and applied GPU preference, and working encoders. */
  gpuReport(): Promise<GpuReport>;
  /** Save the GPU to composite on. Takes effect on the next launch. */
  setGpuPreference(preference: GpuPreference): Promise<void>;
  /** Restart the app, so a new GPU preference applies. */
  relaunch(): Promise<void>;

  /**
   * Stash the rendered audio mix as a temporary WAV and return its path, to be
   * passed back as `ExportSettings.audioPath`. ffmpeg needs the audio as a file
   * input, so it must exist before the encoder is spawned.
   */
  writeExportAudio(wav: ArrayBuffer): Promise<string>;

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
