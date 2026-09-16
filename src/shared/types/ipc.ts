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
  openMediaFolder: 'dialog:open-media-folder',
  registerDroppedFiles: 'drop:register-files',
  registerDroppedFolders: 'drop:register-folders',
  mediaUrl: 'media:url',
  extractAudio: 'media:extract-audio',
  openProject: 'dialog:open-project',
  projectsList: 'projects:list',
  projectsOpenRecent: 'projects:open-recent',
  projectsForget: 'projects:forget',
  projectsDefaultFolder: 'projects:default-folder',
  projectsChooseFolder: 'projects:choose-folder',
  projectsCreate: 'projects:create',
  projectsSave: 'projects:save',
  projectsRecord: 'projects:record',
  documentState: 'app:document-state',
  saveBeforeClose: 'app:save-before-close',
  closeAfterSave: 'app:close-after-save',
  openLut: 'dialog:open-lut',
  saveProjectAs: 'dialog:save-project-as',
  chooseExportPath: 'dialog:choose-export-path',
  chooseExportFolder: 'dialog:choose-export-folder',
  resolveExportTarget: 'export:resolve-target',
  defaultExportFolder: 'export:default-folder',
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
  exportAudioOpen: 'export:audio-open',
  exportAudioAppend: 'export:audio-append',
  exportAudioClose: 'export:audio-close',
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
  /**
   * The folders between the chosen folder and this file, the chosen one
   * first, joined with "/". Set only by a folder import.
   */
  relativeDir?: string;
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
/** A project on the start screen. */
export interface RecentProject {
  path: string;
  name: string;
  /** ISO time it was last opened, created or saved. */
  lastOpened: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  clipCount: number;
  /** The file is still where it was. */
  exists: boolean;
  /** A media:// URL for its thumbnail, when one was taken. */
  thumbnailUrl?: string;
}

/** What a save records about a project for the start screen. */
export interface RecentProjectInput {
  path: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  clipCount: number;
}

export interface FilmoraApi {
  openMedia(): Promise<PickedFile[]>;
  /**
   * A folder and everything under it: each media file with the folders it sits
   * in, so the library can mirror them as bins. Optional so a bridge without
   * it (a browser shim, an older preload) still satisfies the type.
   */
  openMediaFolder?(): Promise<PickedFile[]>;
  /**
   * Files dropped onto the window, resolved to their paths on disk and added
   * to the read allowlist - so a drop is as good as the open dialog: the
   * project can be saved and reopened, and ffmpeg can probe the exact rate.
   * Files with no path on disk are left out of the result.
   */
  registerDroppedFiles(files: File[]): Promise<PickedFile[]>;
  /**
   * Folders dropped onto the window, walked like "Add folder and subfolders":
   * every media file under them, allowlisted, with the folders it sits in.
   * Optional so a bridge without it still satisfies the type.
   */
  registerDroppedFolders?(folders: File[]): Promise<PickedFile[]>;
  /** A `media://` URL that streams an allowlisted file from disk by ranges. */
  mediaUrl(path: string): Promise<string>;
  /**
   * The file's audio track alone, as a small `media://` file for decoding, or
   * null when there is none.
   */
  extractAudio(path: string): Promise<string | null>;
  openProject(): Promise<{ path: string; contents: string } | null>;
  /** Recent projects, newest first, each with whether its file still exists. */
  projectsList(): Promise<RecentProject[]>;
  /** Open a project from the recent list without a dialog; refused for any other path. */
  projectsOpenRecent(path: string): Promise<{ path: string; contents: string } | null>;
  /** Take a project off the list. The file itself is left alone. */
  projectsForget(path: string): Promise<void>;
  /** Documents\STOOK CREATOR FILMS\Projects, created if needed. */
  projectsDefaultFolder(): Promise<string>;
  projectsChooseFolder(): Promise<string | null>;
  /** Write a new project file in `folder`, named after `name` (made unique); returns its path. */
  projectsCreate(folder: string, name: string, contents: string): Promise<string>;
  /** Save over a project file this session opened, created or saved. */
  projectsSave(path: string, contents: string): Promise<string>;
  /** Put a project at the top of the recent list, with an optional JPEG thumbnail. */
  projectsRecord(project: RecentProjectInput, thumbnail?: ArrayBuffer): Promise<void>;
  /** Tell the window whether there are unsaved changes, so closing can ask. */
  documentState(state: { dirty: boolean; name: string }): void;
  /** The window asked to save before closing; save, then call closeAfterSave. */
  onSaveBeforeClose(listener: () => void): () => void;
  closeAfterSave(): Promise<void>;
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
  ): Promise<{ path: string; exists: boolean; inUse: boolean }>;
  /** Documents\VIDEOS EXPORTADOS, created if missing and allowed as an export folder. */
  defaultExportFolder(): Promise<string>;
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
  /** Start a streamed mix file; returns its path, allowlisted for the export. */
  exportAudioOpen(): Promise<string>;
  /** Append interleaved float32 samples to an open mix. */
  exportAudioAppend(path: string, samples: ArrayBuffer): Promise<void>;
  /** Close a mix; `discard` deletes it (nothing audible, or the render failed). */
  exportAudioClose(path: string, discard?: boolean): Promise<void>;

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
