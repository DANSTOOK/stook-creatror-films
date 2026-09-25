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
  projectsBackups: 'projects:backups',
  projectsBackupRead: 'projects:backup-read',
  projectsRecoveryWrite: 'projects:recovery-write',
  projectsRecoveryRead: 'projects:recovery-read',
  projectsRecoveryClear: 'projects:recovery-clear',
  proxiesFind: 'proxies:find',
  proxiesBuild: 'proxies:build',
  proxiesCancel: 'proxies:cancel',
  proxiesClear: 'proxies:clear',
  proxiesUsage: 'proxies:usage',
  proxiesProgress: 'proxies:progress',
  documentState: 'app:document-state',
  saveBeforeClose: 'app:save-before-close',
  closeAfterSave: 'app:close-after-save',
  menuCommand: 'app:menu-command',
  menuState: 'app:menu-state',
  editText: 'app:edit-text',
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
  exportShowInFolder: 'export:show-in-folder',
  exportPlay: 'export:play',
  youtubeStatus: 'youtube:status',
  youtubeConfigure: 'youtube:configure',
  youtubeForgetClient: 'youtube:forget-client',
  youtubeSignIn: 'youtube:sign-in',
  youtubeCancelSignIn: 'youtube:cancel-sign-in',
  youtubeSignOut: 'youtube:sign-out',
  youtubeUpload: 'youtube:upload',
  youtubeCancelUpload: 'youtube:cancel-upload',
  youtubeProgress: 'youtube:progress',
  youtubeOpenStudio: 'youtube:open-studio',
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
 * What an application-menu item asks the page to do. The menu lives in the
 * main process, but every one of these is the page's own action, so the menu
 * only names it and the page runs it - the same code a toolbar button runs.
 */
export type MenuCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'import'
  | 'export'
  | 'projectSettings'
  | 'home'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'toggleMedia'
  | 'toggleInspector'
  | 'fullscreenViewer'
  | 'resetLayout'
  | 'mixer'
  | 'shortcuts';

/** What the page tells the menu, so it can label, tick and grey its items. */
export interface MenuState {
  language: 'en' | 'es';
  /** The editor is showing, rather than the start screen. */
  editor: boolean;
  canUndo: boolean;
  canRedo: boolean;
  mediaShown: boolean;
  inspectorShown: boolean;
  fullscreenViewer: boolean;
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
/** How a proxy build is getting on, by source path. */
export interface ProxyProgressEvent {
  path: string;
  /** 0 to 1. */
  fraction: number;
}

/** What the proxies take up on disk. */
export interface ProxyUsage {
  count: number;
  bytes: number;
}

/** A copy of a project as it stood before one of its saves. */
export interface ProjectBackup {
  /** Pass this back to `projectsBackupRead`. */
  file: string;
  /** When the save that replaced this copy happened, as an ISO string. */
  savedAt: string;
  bytes: number;
}

/** Unsaved work a previous session left behind. */
export interface ProjectRecovery {
  name: string;
  path: string | null;
  savedAt: string;
  contents: string;
}

export type YouTubePrivacy = 'private' | 'unlisted' | 'public';

/** Where the YouTube connection stands. Never carries a token or the secret. */
export interface YouTubeStatus {
  /** A Google OAuth client has been entered. */
  configured: boolean;
  /** The client ID, to show which one; it is not a secret. */
  clientId: string;
  /** Signed in during this session. Nothing about it outlives the app. */
  signedIn: boolean;
}

export interface YouTubeUploadMeta {
  title: string;
  description: string;
  privacy: YouTubePrivacy;
  /** YouTube requires the answer for every upload. */
  madeForKids: boolean;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  /** What YouTube set. */
  privacy: YouTubePrivacy;
  /** What was asked for; differs when an unaudited project forces private. */
  requestedPrivacy: YouTubePrivacy;
}

export interface YouTubeProgressEvent {
  sent: number;
  total: number;
}

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

  /** The copies kept of this project, newest first. */
  projectsBackups(path: string): Promise<ProjectBackup[]>;
  /** One copy, ready to open. Null if it is not a copy this app keeps. */
  projectsBackupRead(file: string): Promise<string | null>;
  /** Keep unsaved work where the next start can find it. */
  projectsRecoveryWrite(snapshot: { name: string; path: string | null; contents: string }): Promise<void>;
  /** Work left behind by a session that never saved it, if any. */
  projectsRecoveryRead(): Promise<ProjectRecovery | null>;
  /** Nothing left to recover: throw the snapshot away. */
  projectsRecoveryClear(): Promise<void>;

  /** The proxy this file already has, as a URL the preview can play, or null. */
  proxiesFind(path: string): Promise<string | null>;
  /**
   * Build one, or hand back the one that is there. Reports progress on
   * `onProxyProgress` while it runs.
   */
  proxiesBuild(path: string, width: number, height: number, seconds: number): Promise<string | null>;
  /** Stop every build in progress. */
  proxiesCancel(): Promise<void>;
  /** Throw every proxy away; they are rebuilt on demand. */
  proxiesClear(): Promise<ProxyUsage>;
  /** How many proxies are kept, and how much room they take. */
  proxiesUsage(): Promise<ProxyUsage>;
  onProxyProgress(listener: (progress: ProxyProgressEvent) => void): () => void;
  /** Tell the window whether there are unsaved changes, so closing can ask. */
  documentState(state: { dirty: boolean; name: string }): void;
  /** The window asked to save before closing; save, then call closeAfterSave. */
  onSaveBeforeClose(listener: () => void): () => void;
  closeAfterSave(): Promise<void>;
  /** Keep the application menu's labels, ticks and greyed items current. */
  menuState(state: MenuState): void;
  /** An application-menu item was chosen. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /** Cut, copy or paste inside the focused text field, as the menu does it. */
  editText(operation: 'cut' | 'copy' | 'paste'): void;
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
  /** Select a file this session exported in Explorer. Refuses any other path. */
  showExportInFolder(path: string): Promise<void>;
  /** Open a file this session exported in the system's player. Refuses any other path. */
  playExport(path: string): Promise<void>;

  onExportProgress(listener: (progress: ExportProgress) => void): () => void;

  /* YouTube: sign-in in the browser, tokens in memory only. */
  youtubeStatus(): Promise<YouTubeStatus>;
  /** Save the Google OAuth client (desktop type) to use. */
  youtubeConfigure(clientId: string, clientSecret: string): Promise<YouTubeStatus>;
  youtubeForgetClient(): Promise<YouTubeStatus>;
  /** Opens Google's sign-in in the browser; resolves when it comes back. */
  youtubeSignIn(): Promise<YouTubeStatus>;
  youtubeCancelSignIn(): Promise<void>;
  youtubeSignOut(): Promise<YouTubeStatus>;
  /** Upload a file this session exported. */
  youtubeUpload(path: string, meta: YouTubeUploadMeta): Promise<YouTubeUploadResult>;
  youtubeCancelUpload(): Promise<void>;
  onYouTubeProgress(listener: (progress: YouTubeProgressEvent) => void): () => void;
  /** Show the file in Explorer and open YouTube's upload page in the browser. */
  youtubeOpenStudio(path: string): Promise<void>;
}

declare global {
  interface Window {
    filmora: FilmoraApi;
  }
}
