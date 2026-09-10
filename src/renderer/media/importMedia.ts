import type { MediaAsset, MediaKind, ProjectState } from '@shared/types';
import { createId } from '@shared/utils/id';
import { probeMediaElement } from '@renderer/engine/probeMedia';

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
  blob: Blob;
  sourcePath?: string;
}

/**
 * Turn decoded bytes into a fully described asset.
 *
 * Duration, dimensions, transparency and the poster frame all come from the
 * browser decoder, so this works identically with or without Electron.
 */
export async function buildAsset(input: RawImport, fps: number): Promise<MediaAsset> {
  const kind = classifyFile(input.name);
  const uri = URL.createObjectURL(input.blob);

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
    width: probe.width,
    height: probe.height,
    hasAlphaChannel: probe.hasAlphaChannel,
    ...(probe.thumbnailUri ? { thumbnailUri: probe.thumbnailUri } : {}),
  };
}

export interface ImportOutcome {
  assets: MediaAsset[];
  /** Files that were skipped or failed, with the reason, for the UI to report. */
  rejected: { name: string; reason: string }[];
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

  const picked = await window.filmora.openMedia();
  const assets: MediaAsset[] = [];
  const rejected: ImportOutcome['rejected'] = [];

  for (const file of picked) {
    try {
      const bytes = await window.filmora.readFile(file.path);
      const blob = new Blob([bytes], { type: mimeForFile(file.name) });
      assets.push(await buildAsset({ name: file.name, blob, sourcePath: file.path }, fps));
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
        const bytes = await window.filmora.readFile(asset.sourcePath);
        const blob = new Blob([bytes], { type: mimeForFile(asset.name) });
        return { ...asset, uri: URL.createObjectURL(blob), missing: false };
      } catch {
        // The file was moved or deleted since the project was saved.
        return { ...asset, missing: true };
      }
    }),
  );
}

/** Append an asset after whatever already sits on a suitable track. */
export function appendPosition(project: ProjectState, trackId: string): number {
  return Object.values(project.clips)
    .filter((clip) => clip.trackId === trackId)
    .reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
}
