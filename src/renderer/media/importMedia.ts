import type { MediaAsset, MediaKind, ProjectState } from '@shared/types';
import { createId } from '@shared/utils/id';
import { MAX_FRAME_RATE, MIN_FRAME_RATE } from '@shared/utils/frameRate';
import { probeMediaElement } from '@renderer/engine/probeMedia';
import { explainImportFailure } from '@renderer/engine/diagnoseContainer';

/**
 * One import path for every way a file can arrive.
 *
 * Files reach the editor three ways - a native dialog, a drag onto the media
 * panel, or the file picker - and all three converge here, so an asset built
 * from a drop is indistinguishable from one opened through Electron.
 */

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'avif']);

export const SUPPORTED_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
];

/** File input `accept` string, so the picker filters to media. */
export const ACCEPT_ATTRIBUTE = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');

const extensionOf = (name: string): string =>
  name.slice(name.lastIndexOf('.') + 1).toLowerCase();

export function classifyFile(name: string): MediaKind {
  const extension = extensionOf(name);
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'video';
}

export const isSupportedFile = (name: string): boolean =>
  SUPPORTED_EXTENSIONS.includes(extensionOf(name));

/**
 * MIME type for a blob built from raw bytes.
 *
 * Chromium sniffs most containers, so this is not strictly required for MP4 -
 * but WebM and Ogg are matched by type in places, and a typed blob is simply
 * more correct than an untyped one.
 */
export function mimeForFile(name: string): string {
  const extension = extensionOf(name);

  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    tga: 'image/x-tga',
  };

  return map[extension] ?? (classifyFile(name) === 'audio' ? 'audio/*' : 'video/*');
}

/** True when the Electron preload bridge is present. */
export const hasNativeBridge = (): boolean =>
  typeof window !== 'undefined' && typeof window.filmora !== 'undefined';

export interface RawImport {
  name: string;
  /** Bytes in memory - the browser path, for files with no path on disk. */
  blob?: Blob;
  /** A streaming URL - the desktop path; the file never enters memory. */
  uri?: string;
  audioUri?: string;
  sourcePath?: string;
  /** Frame rate from ffmpeg, which is more authoritative than measuring. */
  hintFps?: number;
}

/**
 * Turn decoded bytes into a fully described asset.
 *
 * Duration, dimensions, transparency and the poster frame all come from the
 * browser decoder, so this works identically with or without Electron.
 */
export async function buildAsset(input: RawImport, fps: number): Promise<MediaAsset> {
  const kind = classifyFile(input.name);
  const uri = input.uri ?? (input.blob ? URL.createObjectURL(input.blob) : '');
  if (!uri) throw new Error(`Nothing to import for ${input.name}`);

  const probe = await probeMediaElement(uri, kind);

  const durationFrames =
    kind === 'image'
      ? fps * 5 // Stills default to a five second clip.
      : Math.max(1, Math.round(probe.durationSeconds * fps));

  return {
    id: createId('asset'),
    name: input.name,
    uri,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    kind,
    durationFrames,
    durationSeconds: kind === 'image' ? 5 : probe.durationSeconds,
    width: probe.width,
    height: probe.height,
    hasAlphaChannel: probe.hasAlphaChannel,
    ...(input.hintFps || probe.fps ? { sourceFps: input.hintFps ?? probe.fps } : {}),
    ...(probe.thumbnailUri ? { thumbnailUri: probe.thumbnailUri } : {}),
    ...(input.audioUri ? { audioUri: input.audioUri } : {}),
  };
}

/**
 * Project settings a freshly imported asset implies.
 *
 * An empty project has no opinion yet, so the first clip in decides - the same
 * "new sequence from clip" behaviour every NLE has. Without this the project
 * stays at its 30 fps default and 60 fps footage is silently halved.
 */
export function settingsFromAsset(
  asset: MediaAsset,
): { fps?: number; width?: number; height?: number } | null {
  // Sound has no picture to lend, and a still has none worth lending: its size
  // is whatever the camera or the screen grab happened to be. Importing a
  // screenshot first left the whole project at 890x422. Premiere and Resolve
  // build a sequence from footage, not from photos - a photo is fitted into
  // the sequence instead (see fitToFrame).
  if (asset.kind === 'audio' || asset.kind === 'image') return null;

  const settings: { fps?: number; width?: number; height?: number } = {};

  // Only a rate that could belong to real footage. An absurd measurement
  // used to be adopted as-is, which turned a 36-minute timeline into 16.5
  // million frames (see MAX_FRAME_RATE).
  if (
    asset.sourceFps &&
    asset.sourceFps >= MIN_FRAME_RATE &&
    asset.sourceFps <= MAX_FRAME_RATE
  ) {
    settings.fps = asset.sourceFps;
  }

  if (asset.width > 0 && asset.height > 0) {
    // Even sizes only: yuv420p cannot represent an odd width or height, and
    // a still is quite happily 2070 px wide.
    settings.width = asset.width - (asset.width % 2);
    settings.height = asset.height - (asset.height % 2);
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

export interface ImportOutcome {
  assets: MediaAsset[];
  /** Files that were skipped or failed, with the reason, for the UI to report. */
  rejected: { name: string; reason: string }[];
  /** The folder path each asset was found in (by asset id), for a folder import. */
  folders?: Record<string, string>;
}

/** Import `File` objects - the drag-and-drop and file-picker path. */
export async function importFromFiles(
  files: Iterable<File>,
  fps: number,
): Promise<ImportOutcome> {
  const assets: MediaAsset[] = [];
  const rejected: ImportOutcome['rejected'] = [];

  for (const file of files) {
    if (!isSupportedFile(file.name)) {
      rejected.push({ name: file.name, reason: 'Unsupported file type' });
      continue;
    }

    try {
      // A File is already a Blob, but it may carry an empty or wrong type.
      const blob = file.type ? file : new Blob([await file.arrayBuffer()], { type: mimeForFile(file.name) });
      assets.push(await buildAsset({ name: file.name, blob }, fps));
    } catch (error) {
      rejected.push({
        name: file.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { assets, rejected };
}

/**
 * Import through the native dialog.
 *
 * Only available under Electron; callers should fall back to the file picker
 * when `hasNativeBridge()` is false.
 */
export async function importFromDialog(fps: number): Promise<ImportOutcome> {
  if (!hasNativeBridge()) {
    throw new Error('The native file dialog is only available in the desktop app');
  }

  return importPickedFiles(await window.filmora.openMedia(), fps);
}

/**
 * Import a folder and everything under it, through the native dialog.
 *
 * Each asset comes back with the folder path it was found in - the chosen
 * folder first - for the library to mirror as bins.
 */
export async function importFolderFromDialog(fps: number): Promise<ImportOutcome> {
  if (!hasNativeBridge() || typeof window.filmora.openMediaFolder !== 'function') {
    throw new Error('Adding a folder is only available in the desktop app');
  }

  return importPickedFiles(await window.filmora.openMediaFolder(), fps);
}

/**
 * Import folders dropped from Explorer, subfolders included - the drag
 * equivalent of "Add folder and subfolders".
 *
 * A dropped folder reaches the page as a File with no bytes; the main
 * process resolves its path and walks it.
 */
export async function importDroppedFolders(folders: File[], fps: number): Promise<ImportOutcome> {
  if (folders.length === 0) return { assets: [], rejected: [] };
  if (!hasNativeBridge() || typeof window.filmora.registerDroppedFolders !== 'function') {
    return {
      assets: [],
      rejected: folders.map((folder) => ({ name: folder.name, reason: 'folders can only be added in the desktop app' })),
    };
  }

  const picked = await window.filmora.registerDroppedFolders(folders);
  if (picked.length === 0) {
    return { assets: [], rejected: folders.map((folder) => ({ name: folder.name, reason: 'no media files inside' })) };
  }
  return importPickedFiles(picked, fps);
}

/**
 * Import files dropped onto the window.
 *
 * Under Electron a drop goes through the same path as the open dialog: the
 * file's real path is resolved and allowlisted, so the asset keeps its
 * `sourcePath` (the project reopens with it instead of flagging it missing)
 * and ffmpeg supplies the exact frame rate. Dropping used to skip all of that
 * and import an anonymous blob. In a plain browser, or for anything with no
 * path on disk, the blob import is still the fallback.
 */
export async function importDroppedFiles(files: File[], fps: number): Promise<ImportOutcome> {
  if (!hasNativeBridge() || typeof window.filmora.registerDroppedFiles !== 'function') {
    return importFromFiles(files, fps);
  }

  const supported = files.filter((file) => isSupportedFile(file.name));
  const unsupported = files
    .filter((file) => !isSupportedFile(file.name))
    .map((file) => ({ name: file.name, reason: 'Unsupported file type' }));

  const picked = await window.filmora.registerDroppedFiles(supported);
  const pickedNames = new Set(picked.map((entry) => entry.name));

  // Anything the main process could not resolve to a file on disk.
  const pathless = supported.filter((file) => !pickedNames.has(file.name));

  const [fromDisk, fromBlobs] = await Promise.all([
    importPickedFiles(picked, fps),
    pathless.length > 0 ? importFromFiles(pathless, fps) : Promise.resolve({ assets: [], rejected: [] }),
  ]);

  return {
    assets: [...fromDisk.assets, ...fromBlobs.assets],
    rejected: [...unsupported, ...fromDisk.rejected, ...fromBlobs.rejected],
  };
}

/** Read, probe and build assets for files that have a real path on disk. */
async function importPickedFiles(
  picked: readonly { path: string; name: string; relativeDir?: string }[],
  fps: number,
): Promise<ImportOutcome> {
  const assets: MediaAsset[] = [];
  const rejected: ImportOutcome['rejected'] = [];
  const folders: Record<string, string> = {};

  for (const file of picked) {
    try {
      // Streamed from disk by ranges, never read into memory: a 45-minute file
      // used to cost ~6 GB in each process while importing.
      const kind = classifyFile(file.name);
      const [uri, probe, audioUri] = await Promise.all([
        window.filmora.mediaUrl(file.path),
        // ffmpeg knows the exact rate; measuring is the fallback for drops.
        window.filmora.probeMedia(file.path).catch(() => null),
        kind === 'image' ? Promise.resolve(null) : window.filmora.extractAudio(file.path).catch(() => null),
      ]);

      const asset = await buildAsset(
        {
          name: file.name,
          uri,
          sourcePath: file.path,
          ...(audioUri ? { audioUri } : {}),
          ...(probe?.fps ? { hintFps: probe.fps } : {}),
        },
        fps,
      );
      assets.push(asset);
      if (file.relativeDir) folders[asset.id] = file.relativeDir;
    } catch (error) {
      const reported = error instanceof Error ? error.message : String(error);
      // The decoder only ever says it could not decode the file. Read the
      // container's top-level boxes and, when they show the file simply stops
      // short, say that instead - it points at the file rather than the app.
      const reason = await explainImportFailure(
        await window.filmora.mediaUrl(file.path).catch(() => ''),
        reported,
      );
      rejected.push({ name: file.name, reason });
    }
  }

  return { assets, rejected, ...(Object.keys(folders).length > 0 ? { folders } : {}) };
}

/**
 * Rebuild blob URLs for a reopened project.
 *
 * Object URLs die with the page, so a saved project stores the path on disk and
 * re-reads it here. Assets with no path (dropped into a browser session) cannot
 * be restored and are flagged so the UI can say which media is missing.
 */
export async function rehydrateAssets(assets: MediaAsset[]): Promise<MediaAsset[]> {
  if (!hasNativeBridge()) {
    return assets.map((asset) => ({ ...asset, missing: true }));
  }

  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.sourcePath) return { ...asset, missing: true };

      try {
        const [uri, audioUri] = await Promise.all([
          window.filmora.mediaUrl(asset.sourcePath),
          asset.kind === 'image'
            ? Promise.resolve(null)
            : window.filmora.extractAudio(asset.sourcePath).catch(() => null),
        ]);
        const { audioUri: _stale, ...rest } = asset;
        void _stale;
        return { ...rest, uri, ...(audioUri ? { audioUri } : {}), missing: false };
      } catch {
        // The file was moved or deleted since the project was saved.
        return { ...asset, missing: true };
      }
    }),
  );
}

/**
 * Rebuild a whole saved document.
 *
 * Rehydrating the assets alone is not enough, and getting this wrong is
 * invisible in the media panel: clips reference their source by URL, so after
 * reopening they still point at blob URLs that died with the previous session.
 * The panel looks perfectly healthy while the timeline renders nothing and
 * exports silently lose their audio.
 *
 * The old URL is the only link between a clip and its asset in a saved file, so
 * it is kept as the key and every clip is remapped onto the new one.
 */
export function buildUriRemap(
  before: readonly MediaAsset[],
  after: readonly MediaAsset[],
): Map<string, string> {
  const remap = new Map<string, string>();

  for (const restored of after) {
    // Assets are matched by identity, not by position: an id survives the round
    // trip through the file, and index order is not something to rely on.
    const original = before.find((asset) => asset.id === restored.id);
    if (original && original.uri && original.uri !== restored.uri) {
      remap.set(original.uri, restored.uri);
    }
  }

  return remap;
}

export function remapClipSources(
  project: ProjectState,
  remap: ReadonlyMap<string, string>,
): ProjectState {
  if (remap.size === 0) return project;

  const clips = Object.fromEntries(
    Object.entries(project.clips).map(([id, clip]) => {
      const replacement = remap.get(clip.sourceUri);
      return [id, replacement ? { ...clip, sourceUri: replacement } : clip];
    }),
  );

  return { ...project, clips };
}

export async function rehydrateDocument(
  assets: MediaAsset[],
  project: ProjectState,
): Promise<{ assets: MediaAsset[]; project: ProjectState }> {
  const restored = await rehydrateAssets(assets);
  const withLuts = await rehydrateLuts(project);

  return {
    assets: restored,
    project: remapClipSources(withLuts, buildUriRemap(assets, restored)),
  };
}

/**
 * Rebuild LUT blob URLs for a reopened project.
 *
 * Same failure as media: a look loaded from a `.cube` file lives behind an
 * object URL that dies with the page, so reopening a graded project silently
 * dropped every LUT. The path is what survives; the URL is rebuilt from it.
 */
export async function rehydrateLuts(project: ProjectState): Promise<ProjectState> {
  if (!hasNativeBridge()) return project;

  const clips = { ...project.clips };
  let changed = false;

  await Promise.all(
    Object.values(clips).map(async (clip) => {
      const { lutSourcePath } = clip.colorGrading;
      if (!lutSourcePath) return;

      try {
        const contents = await window.filmora.readTextFile(lutSourcePath);
        const uri = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
        clips[clip.id] = { ...clip, colorGrading: { ...clip.colorGrading, lutUri: uri } };
      } catch {
        // Moved or deleted since the project was saved: drop the reference
        // rather than leaving a URL that resolves to nothing.
        clips[clip.id] = {
          ...clip,
          colorGrading: { ...clip.colorGrading, lutUri: undefined },
        };
      }
      changed = true;
    }),
  );

  return changed ? { ...project, clips } : project;
}

/** Append an asset after whatever already sits on a suitable track. */
export function appendPosition(project: ProjectState, trackId: string): number {
  return Object.values(project.clips)
    .filter((clip) => clip.trackId === trackId)
    .reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
}
