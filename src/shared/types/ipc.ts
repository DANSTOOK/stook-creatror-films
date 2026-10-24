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
  detectSilences: 'media:detect-silences',
  detectScenes: 'media:detect-scenes',
  detectBeats: 'media:detect-beats',
  saveStill: 'media:save-still',
  saveSticker: 'media:save-sticker',
  saveSound: 'media:save-sound',
  findSound: 'media:find-sound',
  trackObject: 'media:track-object',
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
  playableCopy: 'media:playable-copy',
  playableProgress: 'media:playable-progress',
  proxiesCancel: 'proxies:cancel',
  proxiesClear: 'proxies:clear',
  proxiesUsage: 'proxies:usage',
  proxiesProgress: 'proxies:progress',
  contentPeaks: 'content:peaks',
  relinkPick: 'relink:pick',
  relinkFind: 'relink:find',
  relinkApply: 'relink:apply',
  contentThumbs: 'content:thumbs',
  videoFrameTimes: 'media:video-frame-times',
  documentState: 'app:document-state',
  setAppearance: 'app:set-appearance',
  clipboardWrite: 'app:clipboard-write',
  templatesList: 'templates:list',
  cloudBackupState: 'cloud-backup:state',
  logWrite: 'log:write',
  logState: 'log:state',
  logReport: 'log:report',
  logOpen: 'log:open',
  cloudBackupChoose: 'cloud-backup:choose',
  cloudBackupSet: 'cloud-backup:set',
  cloudBackupNow: 'cloud-backup:now',
  cloudBackupOpen: 'cloud-backup:open',
  templateSave: 'templates:save',
  templateRead: 'templates:read',
  templateDelete: 'templates:delete',
  saveBeforeClose: 'app:save-before-close',
  closeAfterSave: 'app:close-after-save',
  menuCommand: 'app:menu-command',
  menuState: 'app:menu-state',
  editText: 'app:edit-text',
  appMenuModel: 'app:menu-model',
  appMenuInvoke: 'app:menu-invoke',
  windowFullScreen: 'app:window-full-screen',
  focusPanelWindow: 'app:focus-panel-window',
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
  exportTempVideo: 'export:temp-video',
  denoiseAudio: 'media:denoise-audio',
  stabilizeVideo: 'media:stabilize-video',
  stabilizeProgress: 'media:stabilize-progress',
  saveRecording: 'media:save-recording',
  captureSources: 'capture:sources',
  saveScreenRecording: 'capture:save',
  compoundTarget: 'compound:target',
  alignBySound: 'media:align-by-sound',
  captureStopShortcut: 'capture:stop-shortcut',
  captureStopPressed: 'capture:stop-pressed',
  exportDeliver: 'export:deliver',
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
  captionsStatus: 'captions:status',
  captionsModelDownload: 'captions:model-download',
  captionsModelCancel: 'captions:model-cancel',
  captionsModelImport: 'captions:model-import',
  captionsModelDelete: 'captions:model-delete',
  captionsModelProgress: 'captions:model-progress',
  captionsAudioOpen: 'captions:audio-open',
  captionsAudioAppend: 'captions:audio-append',
  captionsAudioClose: 'captions:audio-close',
  captionsTranscribe: 'captions:transcribe',
  captionsCancel: 'captions:cancel',
  captionsProgress: 'captions:progress',
  captionsOpenFile: 'captions:open-file',
  captionsSaveFile: 'captions:save-file',
  captionsWriteSidecar: 'captions:write-sidecar',
  captionsWriteTemp: 'captions:write-temp',
  ttsStatus: 'tts:status',
  ttsVoiceDownload: 'tts:voice-download',
  ttsVoiceCancel: 'tts:voice-cancel',
  ttsVoiceDelete: 'tts:voice-delete',
  ttsVoiceProgress: 'tts:voice-progress',
  ttsPreview: 'tts:preview',
  ttsGenerate: 'tts:generate',
  ttsCancel: 'tts:cancel',
  ttsProgress: 'tts:progress',
  mattesStatus: 'mattes:status',
  mattesModelDownload: 'mattes:model-download',
  mattesModelCancel: 'mattes:model-cancel',
  mattesModelProgress: 'mattes:model-progress',
  mattesFind: 'mattes:find',
  mattesBuild: 'mattes:build',
  mattesCancel: 'mattes:cancel',
  mattesDelete: 'mattes:delete',
  mattesProgress: 'mattes:progress',
  mattesPartial: 'mattes:partial',
  mattesModelDelete: 'mattes:model-delete',
  mattesClearCache: 'mattes:clear-cache',
} as const;

/* Remove background ------------------------------------------------------------ */

export interface MatteModelStatus {
  id: import('./index').MatteModelId;
  bytes: number;
  /** On this computer and verified against its fixed SHA-256. */
  present: boolean;
  /** The size of the file on disk, measured; 0 when it is not here. */
  fileBytes: number;
  /** Where it would be downloaded from, and its licence. */
  source: string;
  licence: string;
}

export interface MatteEngineStatus {
  /** The runtime (onnxruntime) loads in this build. */
  available: boolean;
  /** What the last analysis ran on, once one has run this session. */
  device: 'gpu' | 'cpu' | null;
  models: MatteModelStatus[];
  /** The matte cache on disk, measured: finished files and any temporary one. */
  cache: { files: number; bytes: number };
  /** The models an analysis is running or waiting with: deleting one, or the cache, is refused until it ends. */
  analysing: import('./index').MatteModelId[];
}

export interface MatteModelProgress {
  id: import('./index').MatteModelId;
  received: number;
  total: number;
}

/** One file to analyse: what the page knows of it from the import. */
export interface MatteBuildRequest {
  path: string;
  model: import('./index').MatteModelId;
  width: number;
  height: number;
  /** Its own frame rate; ignored for a still. */
  fps: number;
  seconds: number;
  still: boolean;
}

export interface MatteProgressEvent {
  path: string;
  model: import('./index').MatteModelId;
  done: number;
  total: number;
  msPerFrame: number;
  device: 'gpu' | 'cpu' | null;
  /**
   * The file the analysis is writing, as a URL the page can read by range,
   * once it holds at least one finished frame; null before. Which of its
   * bytes are finished is asked of `mattesPartial`.
   */
  partialUrl: string | null;
}

/**
 * What an analysis still running has finished: the frames written so far,
 * whose bytes never change again (shared/matte/format.ts).
 */
export interface MattePartial {
  width: number;
  height: number;
  fps: number;
  /** The offsets from the one asked for on: frame i is the bytes [offsets[i], offsets[i + 1]). */
  offsets: number[];
  /** The finished frames' presentation times, in seconds, from the same frame on. */
  times: number[];
}

/* Captions ------------------------------------------------------------------ */

/** The two speech models on offer: see main/subtitles/catalog.ts. */
export type CaptionModelId = 'precise' | 'fast';

export interface CaptionModelStatus {
  id: CaptionModelId;
  file: string;
  bytes: number;
  /** On this computer and verified against its fixed SHA-256. */
  present: boolean;
  /** Where it would be downloaded from. */
  source: string;
}

export interface CaptionEngineStatus {
  /** The speech-to-text program is part of this build. */
  available: boolean;
  /** It can use the GPU (a Vulkan build) - whether a GPU is used depends on what it finds. */
  vulkan: boolean;
  /** The GPU it will use, by name, when there is one it will use. */
  gpu: string | null;
  /** The voice detector (Silero VAD) ships with it. */
  vad: boolean;
  models: CaptionModelStatus[];
}

export interface CaptionModelProgress {
  id: CaptionModelId;
  received: number;
  total: number;
}

export interface CaptionTranscribeRequest {
  model: CaptionModelId;
  language: 'es' | 'en';
  /**
   * Names and terms to lean the spelling towards: Whisper's initial prompt
   * (renderer/captions/glossary.ts). Empty or absent: none.
   */
  prompt?: string;
  /** Listen only to what the voice detector hears as speech. Absent: yes, when the build has it. */
  vad?: boolean;
}

export interface CaptionTranscribeResult {
  cancelled: boolean;
  words: import('./index').CaptionWord[];
  /** Segments dropped as made up (see shared/captions/whisperOutput). */
  dropped: string[];
  /** What did the work: 'gpu' (Vulkan) or 'cpu'. */
  ran: 'gpu' | 'cpu';
  gpu: string | null;
  /** Seconds of sound transcribed, and how long it took. */
  audioSeconds: number;
  elapsedSeconds: number;
  /**
   * Stretches of speech the voice detector kept - only those were listened
   * to. Null when it did not run (a build without it, or its table of times
   * could not be read and the sound was transcribed whole instead).
   */
  vadSegments: number | null;
}

export interface CaptionProgressEvent {
  jobId: string;
  /** 0-1 through the transcription (the audio mix is the page's own progress). */
  fraction: number;
}

/* Text to speech ------------------------------------------------------------- */

/** A voice id from main/tts/catalog.ts, e.g. 'es-ES-davefx'. */
export type TtsVoiceId = string;

/** A character for a generated voice (main/tts/finish.ts). */
export type TtsEffect = 'none' | 'warm' | 'radio' | 'phone' | 'megaphone' | 'robot' | 'whisper' | 'cave' | 'stadium';

export interface TtsVoiceStatus {
  id: TtsVoiceId;
  /** Which program speaks it. */
  engine: 'piper' | 'kokoro';
  /** A person's name for it (Dora, Aldo, ...). */
  name: string;
  /** What it sounds like, as an i18n key's last part (tts.persona.<persona>). */
  persona: string;
  language: 'es' | 'en';
  region: string;
  sex: 'male' | 'female';
  licence: string;
  /** Part of the installer: always here, never downloaded. */
  bundled: boolean;
  /** On this computer and ready to use (bundled, or downloaded and verified). */
  present: boolean;
  /** Bytes to fetch for a downloadable voice not yet here; 0 when bundled or present. */
  downloadBytes: number;
}

export interface TtsEngineStatus {
  /** The text-to-speech program is part of this build. */
  available: boolean;
  /** This engine (Piper) controls speed but not pitch. */
  supportsPitch: boolean;
  /**
   * The audio is machine-generated; the chosen engine's licence may require
   * the user to disclose that when publishing. Shown in the panel when true.
   */
  disclosureRequired: boolean;
  voices: TtsVoiceStatus[];
  /** Where downloadable voices come from, as the permission prompt names it. */
  voiceSource: string;
}

export interface TtsVoiceProgress {
  id: TtsVoiceId;
  received: number;
  total: number;
}

export interface TtsRequest {
  text: string;
  voice: TtsVoiceId;
  /** 0.5-2, where 1 is the voice's natural pace. */
  speed: number;
  /** Semitones up or down (-6..6), the pace kept (main/tts/finish.ts). 0 or absent: the voice's own. */
  pitch?: number;
  /** "Clear voice": cleaned, compressed and levelled to -16 LUFS. On unless false. */
  enhance?: boolean;
  /** A character: narrator's warmth, radio, phone, robot, ... (main/tts/finish.ts). None when absent. */
  effect?: TtsEffect;
}

export interface TtsResult {
  cancelled: boolean;
  /** The WAV written, ready to import; null when cancelled. */
  path: string | null;
  durationSeconds: number;
}

export interface TtsProgressEvent {
  jobId: string;
  /** 0-1 through synthesis. */
  fraction: number;
}

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
/** One of the user's own project templates. */
export interface LogState {
  folder: string;
  file: string;
  errorsToday: number;
  lastError: { at: string; message: string } | null;
}

export interface CloudBackupState {
  folder: string | null;
  candidates: Array<{ label: string; path: string }>;
  lastAt: string | null;
  lastFile: string | null;
  lastError: string | null;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  savedAt: string;
  clips: number;
  width: number;
  height: number;
}

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
  | 'toggleTimeline'
  | 'fullscreenViewer'
  | 'resetLayout'
  | 'mixer'
  | 'shortcuts'
  | 'tour'
  | 'openLog'
  | 'copyDiagnostics'
  | 'saveTemplate'
  | 'commandPalette'
  | 'preferences'
  | 'addTitle'
  | 'addLowerThird'
  | 'addCredits'
  | 'addTransition'
  | 'generateCaptions'
  | 'importCaptions'
  | 'exportCaptions'
  | 'textToSpeech'
  | 'fontLicenses'
  | 'detachAudio'
  | 'rejoinAudio'
  | 'loopPlayback';

/** What the page tells the menu, so it can label, tick and grey its items. */
export interface MenuState {
  language: 'en' | 'es';
  /** The editor is showing, rather than the start screen. */
  editor: boolean;
  canUndo: boolean;
  canRedo: boolean;
  mediaShown: boolean;
  inspectorShown: boolean;
  timelineShown: boolean;
  fullscreenViewer: boolean;
  /** Loop playback is on: ticked in View > Loop playback. Absent from an older page: off. */
  loopPlayback?: boolean;
}

/**
 * One entry of the application menu, as the page draws it.
 *
 * The window has no native menu bar any more - the title bar is the page's
 * own - so the page shows the same menu in its menu button. It is read from
 * the main process's Menu rather than kept as a second list, so the two can
 * never disagree; choosing an entry clicks the real item by its id.
 */
export interface AppMenuEntry {
  id?: string;
  /** Without the "&" mnemonic markers. */
  label: string;
  type: 'normal' | 'separator' | 'checkbox' | 'submenu';
  /** As Electron writes it, e.g. "CmdOrCtrl+S". */
  accelerator?: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: AppMenuEntry[];
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
  /**
   * Where the sound of `path` goes quiet between two times of the file, for
   * "Remove silences" (main/media/silence.ts). Seconds of the file; empty
   * for a file with no sound.
   */
  detectSilences(
    path: string,
    request: { noiseDb: number; minSeconds: number; fromSeconds: number; toSeconds: number },
  ): Promise<Array<{ start: number; end: number }>>;
  /** Where the picture of `path` changes shot between two times of the file (main/media/scenes.ts), in seconds of the file. */
  detectScenes(path: string, request: { threshold: number; fromSeconds: number; toSeconds: number }): Promise<number[]>;
  /** The beats of a stretch of a file's music (main/media/beats.ts): its tempo, and seconds from the stretch's start. */
  detectBeats(path: string, fromSeconds: number, toSeconds: number): Promise<{ bpm: number; beats: number[]; downbeats: number[] }>;
  /**
   * Keep a sticker's picture (a PNG the page drew, renderer/stickers) where
   * it lasts - the app's own folder, not the temporary one - and return its
   * path, ready to import. The same sticker in the same language is one file.
   */
  saveSticker(id: string, png: ArrayBuffer): Promise<string>;
  /** A sound of the library (renderer/sounds), rendered as a WAV and kept in the app's folder; its path. */
  saveSound(id: string, wav: ArrayBuffer): Promise<string>;
  /** That sound's file when it was made before, or null. */
  findSound(id: string): Promise<string | null>;
  /** A still the editor made (a freeze frame), kept in the app's folder; its path. */
  saveStill(id: string, png: ArrayBuffer): Promise<string>;
  /**
   * Follow a thing through a stretch of `path` from the box drawn round it
   * on the first frame (main/media/trackJob.ts): its centre, 0..1 of the
   * picture, at each sampled moment, with how well it matched.
   */
  trackObject(
    path: string,
    request: {
      fromSeconds: number;
      toSeconds: number;
      sampleFps: number;
      box: { x: number; y: number; width: number; height: number };
      sourceWidth: number;
      sourceHeight: number;
    },
  ): Promise<Array<{ t: number; x: number; y: number; score: number; scale: number; angle: number }>>;
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
  /**
   * A copy of a video the decoder can open, for one it turned away
   * (main/media/playable.ts): repacked as it is ('remux'), or made H.264
   * ('transcode'). A URL to play, or null when ffmpeg could not make one.
   * Reports progress on `onPlayableProgress`.
   */
  playableCopy(path: string, mode: 'remux' | 'transcode', seconds: number): Promise<string | null>;
  onPlayableProgress(listener: (progress: ProxyProgressEvent) => void): () => void;
  /**
   * The file's waveform, measured by ffmpeg in the main process and kept on
   * disk: a `media://` URL of the peaks file, or null when it has no sound.
   * Optional so a bridge without it (a browser shim) still satisfies the type.
   */
  contentPeaks?(path: string, seconds: number): Promise<string | null>;
  /** Find a missing file: the Open dialog where it used to be; the chosen path, allowlisted, or null. */
  relinkPick?(name: string, oldPath: string | undefined, kind: MediaKind): Promise<string | null>;
  /** Which of these file names are in `folder` (one a relinked file was picked from). */
  relinkFind?(folder: string, names: string[]): Promise<{ name: string; path: string }[]>;
  /** Point a missing clip's URL at its found file; the URL to use from now on. */
  relinkApply?(url: string, path: string): Promise<string>;
  /** The file's filmstrip, made the same way: a `media://` URL, or null. */
  contentThumbs?(path: string, kind: 'video' | 'image', seconds: number, quick?: boolean): Promise<string | null>;
  /**
   * The presentation time of every frame of the file's video, in seconds and
   * ascending, listed by ffmpeg without decoding, with the container's start
   * time; null when ffmpeg finds none. The export checks a seeked <video>
   * against it. Optional so a bridge without it still satisfies the type.
   */
  videoFrameTimes?(path: string): Promise<{ times: number[]; startSeconds: number } | null>;
  /** Tell the window whether there are unsaved changes, so closing can ask. */
  documentState(state: { dirty: boolean; name: string }): void;
  /** An automated run (SCF_BACKGROUND): no welcome tour over the tests, unless one asks for it (SCF_TOUR). */
  automated: boolean;
  /** Text onto the system clipboard (YouTube chapters, for one). */
  clipboardWrite(text: string): Promise<void>;
  /** The user's own project templates (renderer/project/templates.ts), newest first. */
  templatesList(): Promise<ProjectTemplate[]>;
  /** Copies of every save in a cloud folder (main/projects/cloudBackup.ts): where, and how the last went. */
  cloudBackupState(): Promise<CloudBackupState>;
  /** A folder picked in a dialog becomes where copies go. */
  cloudBackupChoose(): Promise<CloudBackupState>;
  /** One of the cloud folders found becomes where copies go, or (null) none. */
  cloudBackupSet(folder: string | null): Promise<CloudBackupState>;
  /** A copy of this project file now. */
  cloudBackupNow(path: string): Promise<CloudBackupState>;
  /** The copies' folder, in the file manager. */
  cloudBackupOpen(): Promise<void>;
  /** An entry for the app's log (main/logging/log.ts). Fire and forget. */
  logWrite(entry: { level: 'error' | 'warn' | 'info'; source?: string; message: string; stack?: string; context?: Record<string, unknown> }): void;
  /** Where the log is, and today's errors. */
  logState(): Promise<LogState>;
  /** The machine and the newest lines, for "Copy diagnostic report". */
  logReport(): Promise<string>;
  /** The log's folder, in the file manager. */
  logOpen(): Promise<void>;
  /** A project kept as a template under `name`: its id. */
  templateSave(name: string, documentJson: string): Promise<string>;
  /** A template's project document, as saved. */
  templateRead(id: string): Promise<string>;
  templateDelete(id: string): Promise<void>;
  /**
   * The look chosen in Preferences, for what the page cannot paint itself:
   * Windows' caption buttons and their strip, native scrollbars and menus,
   * and whether "system" can see Windows' own setting at all. Answers with
   * the look it comes to: for "system", Windows' own.
   */
  setAppearance(theme: 'dark' | 'light' | 'system', resolved: 'dark' | 'light'): Promise<'dark' | 'light'>;
  /** The window asked to save before closing; save, then call closeAfterSave. */
  onSaveBeforeClose(listener: () => void): () => void;
  closeAfterSave(): Promise<void>;
  /** Keep the application menu's labels, ticks and greyed items current. */
  menuState(state: MenuState): void;
  /** An application-menu item was chosen. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /** Cut, copy or paste inside the focused text field, as the menu does it. */
  editText(operation: 'cut' | 'copy' | 'paste'): void;
  /** The application menu, to draw in the title bar's menu button. */
  appMenuModel(): Promise<AppMenuEntry[]>;
  /** Choose an application-menu entry by its id, as a click on it would. */
  appMenuInvoke(id: string): void;
  /** The whole screen for the picture (the full-screen viewer), or back. */
  setWindowFullScreen(on: boolean): void;
  /**
   * Bring a detached panel's own window to the front (and out of the taskbar
   * if it was minimised). The page's own `window.focus()` on it does nothing
   * in Electron, so the main process does it.
   */
  focusPanelWindow(panel: string): void;
  /**
   * Windows' "Animation effects" is off (Settings > Accessibility > Visual
   * effects), read once as the window opened. The page also follows the
   * prefers-reduced-motion media query, which Chromium keeps up to date; this
   * is the same setting straight from the system, in case the two disagree.
   * Optional: a browser shim has no system to ask.
   */
  systemReducedMotion?: boolean;
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
  /**
   * A file's sound with its noise taken out (main/media/denoise.ts), made once
   * and kept; a URL to play, like extractAudio's.
   */
  /** The file's sound with its noise taken out at `strength` (null: none), and enhanced as a voice when `enhance` (main/media/denoise.ts). */
  denoiseAudio(path: string, strength: 'light' | 'medium' | 'strong' | null, enhance?: boolean): Promise<string>;
  /**
   * The file at `path`, stabilized (main/media/stabilize.ts): the stabilized
   * file's path, found from before or made now. `retarget` is the media URL
   * the editor shows the file by; it is pointed at the stabilized file (or,
   * with no strength, back at the original) and kept.
   */
  stabilizeVideo(path: string, strength: 'light' | 'medium' | 'strong' | null, durationSeconds: number, retarget?: string): Promise<string>;
  onStabilizeProgress(listener: (progress: { path: string; fraction: number }) => void): () => void;
  /**
   * A voice-over just recorded (WebM/Opus from MediaRecorder), kept in the
   * app's folder as an M4A that plays and streams like any imported sound.
   * `name` is the file's name without its extension; its path.
   */
  saveRecording(name: string, webm: ArrayBuffer): Promise<string>;
  /** The screens and windows that can be recorded, each with a small picture of itself (a PNG data URL). */
  captureSources(): Promise<Array<{ id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }>>;
  /**
   * A screen or webcam recording (WebM from MediaRecorder), kept in the app's
   * folder as an MP4 that edits like any footage (H.264 at a steady 30 fps,
   * AAC); its path. `name` is the file's name without its extension.
   */
  saveScreenRecording(name: string, webm: ArrayBuffer): Promise<string>;
  /** Where a compound clip's render goes: a new .webm in the app's folder, allowed to be written. */
  compoundTarget(): Promise<string>;
  /**
   * Files lined up with the first by their sound (main/media/audioSync.ts):
   * the seconds into each at which the first one's start is heard, and how
   * sure; null for one with no sound to go by.
   */
  alignBySound(paths: string[]): Promise<({ seconds: number; confidence: number } | null)[]>;
  /** While a screen is recorded, Ctrl+Shift+F9 stops it from anywhere; on is true while recording. */
  captureStopShortcut(on: boolean): Promise<boolean>;
  onCaptureStop(listener: () => void): () => void;
  /** A place in the temp folder for a video a GIF is then made from. */
  exportTempVideo(): Promise<string>;
  /**
   * A file made from a finished render (main/exporter/deliverables.ts): a GIF
   * from `source` (a temporary video, removed after), or MP3/WAV from `source`
   * (the raw mix, removed after). Written as `name` in `folder`; its path.
   */
  exportDeliver(
    folder: string,
    name: string,
    kind: 'gif' | 'mp3' | 'wav',
    source: string,
    options: { fps?: number; width?: number; sampleRate?: number; channels?: number },
  ): Promise<string>;

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

  /* Captions: speech to text on this computer. Optional, so a browser shim without them still fits. */
  /** Whether the engine is there, which GPU it will use, and which models are on disk. */
  captionsStatus?(): Promise<CaptionEngineStatus>;
  /**
   * Download a model from its official source and verify it. The ONLY call
   * here that uses the network: ask the person first. Resolves with the new
   * status - the model absent if the download was cancelled.
   */
  captionsModelDownload?(id: CaptionModelId): Promise<CaptionEngineStatus>;
  captionsModelCancel?(id: CaptionModelId): Promise<void>;
  /** Pick a model file already on this computer; null if the dialog was cancelled. */
  captionsModelImport?(): Promise<CaptionEngineStatus | null>;
  captionsModelDelete?(id: CaptionModelId): Promise<CaptionEngineStatus>;
  onCaptionModelProgress?(listener: (progress: CaptionModelProgress) => void): () => void;
  /** Start a transcription job; returns its id. The mix follows, a piece at a time. */
  captionsAudioOpen?(): Promise<string>;
  /** Interleaved float32, 48 kHz stereo: the mix an export makes. */
  captionsAudioAppend?(jobId: string, samples: ArrayBuffer): Promise<void>;
  captionsAudioClose?(jobId: string): Promise<void>;
  captionsTranscribe?(jobId: string, request: CaptionTranscribeRequest): Promise<CaptionTranscribeResult>;
  captionsCancel?(jobId: string): Promise<void>;
  onCaptionProgress?(listener: (progress: CaptionProgressEvent) => void): () => void;
  /** Pick an .srt or .vtt and read it. */
  captionsOpenFile?(): Promise<{ path: string; contents: string } | null>;
  /** Ask where to save a subtitle file; the extension chosen picks which of the two is written. */
  captionsSaveFile?(suggestedName: string, srt: string, vtt: string): Promise<string | null>;
  /** Write the subtitle file that goes with a video this session exported; returns its path. */
  /** `tag`, a language code (es, en, es-2), goes into the name when there are several files: name.es.srt. */
  captionsWriteSidecar?(videoPath: string, format: 'srt' | 'vtt', contents: string, tag?: string): Promise<string>;
  /**
   * Stash an .srt as a temporary file and return its path, to be passed as
   * `ExportSettings.subtitles.path`: ffmpeg takes the subtitle track as a
   * file input. The export deletes it when it ends.
   */
  captionsWriteTemp?(srt: string): Promise<string>;

  /* Text to speech: voices synthesised on this computer. Optional, like captions. */
  ttsStatus?(): Promise<TtsEngineStatus>;
  /** Download an optional voice from its pinned source and verify it. Uses the network: ask first. */
  ttsVoiceDownload?(id: TtsVoiceId): Promise<TtsEngineStatus>;
  ttsVoiceCancel?(id: TtsVoiceId): Promise<void>;
  ttsVoiceDelete?(id: TtsVoiceId): Promise<TtsEngineStatus>;
  onTtsVoiceProgress?(listener: (progress: TtsVoiceProgress) => void): () => void;
  /** Synthesise a short preview and return a playable data URL. */
  ttsPreview?(request: TtsRequest): Promise<string>;
  /** Synthesise the full text to a WAV on disk; returns the path for import. */
  ttsGenerate?(jobId: string, request: TtsRequest): Promise<TtsResult>;
  ttsCancel?(jobId: string): Promise<void>;
  onTtsProgress?(listener: (progress: TtsProgressEvent) => void): () => void;

  /* Remove background: mattes computed on this computer. Optional, like captions. */
  mattesStatus?(): Promise<MatteEngineStatus>;
  /**
   * Download a matting model from its pinned source and verify it. Uses the
   * network: ask the person first. Resolves with the new status - the model
   * absent if the download was cancelled.
   */
  mattesModelDownload?(id: import('./index').MatteModelId): Promise<MatteEngineStatus>;
  mattesModelCancel?(id: import('./index').MatteModelId): Promise<void>;
  onMatteModelProgress?(listener: (progress: MatteModelProgress) => void): () => void;
  /** The finished mattes of this file for this model, as a URL the page can read by range, or null. */
  mattesFind?(path: string, model: import('./index').MatteModelId): Promise<string | null>;
  /**
   * Analyse a file: resolves with the mattes' URL, or null when cancelled.
   * One analysis runs at a time; asking again for the same file and model
   * waits for the one already running.
   */
  mattesBuild?(request: MatteBuildRequest): Promise<string | null>;
  mattesCancel?(path: string, model: import('./index').MatteModelId): Promise<void>;
  /** Throw away this file's mattes for this model. */
  mattesDelete?(path: string, model: import('./index').MatteModelId): Promise<void>;
  onMatteProgress?(listener: (progress: MatteProgressEvent) => void): () => void;
  /**
   * The frames an analysis still running has finished, for its `partialUrl`:
   * the offsets from index `from` on (0 for all of them), and their times
   * from frame `from` on. Null once that
   * analysis has ended; its finished file is then found with `mattesFind`.
   */
  mattesPartial?(url: string, from: number): Promise<MattePartial | null>;
  /** Delete a model from this computer; refused while it is analysing or downloading. */
  mattesModelDelete?(id: import('./index').MatteModelId): Promise<MatteEngineStatus>;
  /** Throw every matte away; refused while any analysis runs. */
  mattesClearCache?(): Promise<MatteEngineStatus>;
}

declare global {
  interface Window {
    filmora: FilmoraApi;
  }
}
