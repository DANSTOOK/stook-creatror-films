import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ExportSettings, MediaKind } from '@shared/types';
import { IPC, type MediaProbe, type PickedFile } from '@shared/types/ipc';
import { snapFrameRate } from '@shared/utils/frameRate';
import { EncoderPipeline } from '../exporter/EncoderPipeline';
import { detectHardwareEncoders, resolveFfmpegPath } from '../exporter/HardwareAccel';
import { isGpuPreference } from '../gpu/classify';
import { getGpuReport } from '../gpu/gpuInventory';
import { writeGpuPreference } from '../gpu/gpuSettings';
import { isOpenMediaPath, mediaUrlFor } from './mediaProtocol';

const execFileAsync = promisify(execFile);

/**
 * Native dialogs, file I/O and the export bridge.
 *
 * The renderer can only read files the user has actually chosen through a
 * dialog (or that were opened as a project): every path is added to an
 * allowlist first, so a compromised renderer cannot read arbitrary files.
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tga']);

const allowedPaths = new Set<string>();

/** Source path -> media:// URL of its extracted audio, for the session. */
const extractedAudio = new Map<string, string>();

/** Bounds on a folder import, so choosing a drive root cannot stall the app. */
const MAX_FOLDER_DEPTH = 8;
const MAX_FOLDER_FILES = 2000;

/**
 * Every media file under `root`, allowlisted like a file picked in the Import
 * dialog, each with the folders it sits in - the root's own name first - so
 * the library can mirror them as bins. Shared by "Add folder and subfolders"
 * and folders dropped from Explorer.
 *
 * Hidden entries and links are skipped (a Dirent for a link is neither a file
 * nor a directory), and the walk stops at MAX_FOLDER_DEPTH levels and
 * MAX_FOLDER_FILES files in total across everything added to `picked`.
 */
async function collectMediaFolder(root: string, picked: PickedFile[] = []): Promise<PickedFile[]> {
  const walk = async (folder: string, segments: string[]): Promise<void> => {
    if (segments.length > MAX_FOLDER_DEPTH) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const entry of entries) {
      if (picked.length >= MAX_FOLDER_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);

      if (entry.isDirectory()) {
        await walk(path, [...segments, entry.name]);
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      const isMedia =
        VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension);
      if (!entry.isFile() || !isMedia) continue;

      const info = await stat(path).catch(() => null);
      if (!info) continue;

      allowedPaths.add(path);
      picked.push({ path, name: entry.name, kind: classify(path), sizeBytes: info.size, relativeDir: segments.join('/') });
    }
  };

  // A drive root has no base name; it still needs a bin to go in.
  await walk(root, [basename(root) || root.replace(/[\\/:]+$/, '')]);
  return picked;
}

function classify(path: string): MediaKind {
  const extension = extname(path).toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'video';
}

function assertAllowed(path: string): void {
  if (!allowedPaths.has(path)) {
    throw new Error(`Access denied: "${path}" was not opened through a file dialog`);
  }
}

/**
 * Allowlist the media and LUTs a project file points at.
 *
 * The allowlist lives in memory and starts empty in every session, and opening
 * a project only allowlisted the project file itself - so a project saved
 * yesterday reopened today with EVERY clip marked missing, although the files
 * were exactly where it said. Saving and reopening only ever worked within one
 * run of the app, which is also the only way it was ever tested.
 *
 * Choosing a project is as deliberate as choosing files in the Import dialog,
 * so the files it references are allowed the same way - but only existing
 * files with a media or `.cube` extension, so a crafted project file cannot be
 * used to read anything else.
 */
export async function allowProjectReferences(contents: string): Promise<number> {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    return 0;
  }

  const candidates: string[] = [];
  const doc = document as {
    assets?: { sourcePath?: unknown }[];
    project?: { clips?: Record<string, { colorGrading?: { lutSourcePath?: unknown } }> };
  };

  for (const asset of doc.assets ?? []) {
    if (typeof asset?.sourcePath === 'string') candidates.push(asset.sourcePath);
  }
  for (const clip of Object.values(doc.project?.clips ?? {})) {
    const lut = clip?.colorGrading?.lutSourcePath;
    if (typeof lut === 'string') candidates.push(lut);
  }

  let allowed = 0;
  await Promise.all(
    candidates.map(async (path) => {
      if (!isAbsolute(path)) return;
      const extension = extname(path).toLowerCase();
      const acceptable =
        VIDEO_EXTENSIONS.has(extension) ||
        AUDIO_EXTENSIONS.has(extension) ||
        IMAGE_EXTENSIONS.has(extension) ||
        extension === '.cube';
      if (!acceptable) return;

      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return; // Moved or deleted: stays missing, honestly.

      allowedPaths.add(path);
      allowed += 1;
    }),
  );
  return allowed;
}

/** Folders the user picked as export destinations. */
const allowedFolders = new Set<string>();

export function extensionFor(format: ExportSettings['format']): string {
  return format === 'prores4444' ? 'mov' : format === 'webm-vp9' ? 'webm' : 'mp4';
}

/**
 * Make a typed name safe as a Windows file name inside the chosen folder.
 *
 * Exported for tests. Separators and the characters Windows forbids become
 * `_`, so a name can never climb out of the folder; trailing dots and spaces
 * (which Windows silently strips, renaming the file behind your back) go; a
 * typed extension is dropped because the format decides it; reserved device
 * names (CON, NUL, COM1...) get a suffix, because Windows cannot create them.
 */
export function sanitizeFileName(name: string): string {
  let cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.(mp4|mov|webm|png)$/i, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned.slice(0, 180);
}

/** Pixel formats whose names encode an alpha plane. */
const hasAlphaPixelFormat = (pixelFormat: string | undefined): boolean =>
  pixelFormat !== undefined && /a$|^(yuva|rgba|bgra|argb|abgr|gbrap|pal8)/i.test(pixelFormat);

/**
 * Parse the stream summary ffmpeg prints on stderr.
 *
 * `ffmpeg-static` bundles ffmpeg but NOT ffprobe, and requiring ffprobe on PATH
 * meant this probe effectively never ran. ffmpeg reports everything needed here
 * when asked to open a file with no output, so the bundled binary is enough.
 *
 * Exported for tests: the parsing is the part worth pinning down.
 */
export function parseFfmpegBanner(stderr: string, path: string): MediaProbe {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video =
    /Stream #\d+:\d+.*?: Video:\s*([a-zA-Z0-9_]+)[^\n]*?,\s*([a-z0-9]+)(?:\([^)]*\))?,\s*(\d{2,5})x(\d{2,5})/.exec(
      stderr,
    );
  const fpsMatch = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(stderr);
  const tbrMatch = /,\s*(\d+(?:\.\d+)?)k?\s*tbr/.exec(stderr);
  const audio = /Stream #\d+:\d+.*?: Audio:\s*([a-zA-Z0-9_]+)/.exec(stderr);

  // ffmpeg prints the AVERAGE rate as "fps" and the nominal one as "tbr". A
  // variable-frame-rate phone recording reads "29.99 fps, 30 tbr", and taking
  // the average literally produces a project no container can represent -
  // 180 frames at 29.99 fps muxes to a file that runs 3.5% slow. Snapping
  // resolves it to the rate the footage actually is.
  const rawFps = fpsMatch ? Number(fpsMatch[1]) : Number(tbrMatch?.[1] ?? 30);
  const fps = snapFrameRate(rawFps);

  return {
    path,
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : 0,
    width: video ? Number(video[3]) : 0,
    height: video ? Number(video[4]) : 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    hasAlphaChannel: hasAlphaPixelFormat(video?.[2]),
    hasAudio: audio !== null,
    codec: video?.[1] ?? audio?.[1] ?? 'unknown',
  };
}

async function probeMedia(path: string): Promise<MediaProbe> {
  assertAllowed(path);

  try {
    // Opening a file with no output makes ffmpeg print the stream summary and
    // exit non-zero, so the information arrives via the thrown error.
    await execFileAsync(resolveFfmpegPath(), ['-hide_banner', '-i', path], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseFfmpegBanner('', path);
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    if (stderr.includes('Stream #') || stderr.includes('Duration:')) {
      return parseFfmpegBanner(stderr, path);
    }

    // Genuinely unreadable: the renderer still imports using element metadata.
    return {
      path,
      durationSeconds: 0,
      width: 0,
      height: 0,
      fps: 30,
      hasAlphaChannel: IMAGE_EXTENSIONS.has(extname(path).toLowerCase()),
      hasAudio: false,
      codec: 'unknown',
    };
  }
}

export function registerFileSystemHandlers(getWindow: () => BrowserWindow | null): EncoderPipeline {
  /**
   * Progress, at about ten readings a second rather than one per frame.
   *
   * A render sends thousands of these, and each one crossed IPC and
   * re-rendered the dialog - 0.17 ms a frame, and worse, the jitter of a
   * React commit landing mid-frame. Nobody reads a counter faster than
   * this, but the LAST reading has to arrive or the bar stops short of the
   * end, so a frame that reaches the total is always sent.
   */
  let lastProgressAt = 0;
  const pipeline = new EncoderPipeline((progress) => {
    const now = Date.now();
    const finished = progress.totalFrames > 0 && progress.frame >= progress.totalFrames;
    if (!finished && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    getWindow()?.webContents.send(IPC.exportProgress, progress);
  });

  /**
   * Files dropped onto the window.
   *
   * A drop is as deliberate a choice as the open dialog, so these paths join the
   * allowlist the same way. The paths do not come from page code: the preload
   * derives them with `webUtils.getPathForFile`, which only yields a path for a
   * File the OS handed over, and returns '' for one built in JavaScript. On top
   * of that, only existing regular files with a media extension are accepted,
   * so even a hostile caller could not use this to open anything else.
   */
  ipcMain.handle(IPC.registerDroppedFiles, async (_event, paths: unknown): Promise<PickedFile[]> => {
    if (!Array.isArray(paths)) return [];

    const picked = await Promise.all(
      paths.map(async (path): Promise<PickedFile | null> => {
        if (typeof path !== 'string' || !isAbsolute(path)) return null;

        const extension = extname(path).toLowerCase();
        const isMedia =
          VIDEO_EXTENSIONS.has(extension) ||
          AUDIO_EXTENSIONS.has(extension) ||
          IMAGE_EXTENSIONS.has(extension);
        if (!isMedia) return null;

        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return null;

        allowedPaths.add(path);
        return { path, name: basename(path), kind: classify(path), sizeBytes: info.size };
      }),
    );

    return picked.filter((entry): entry is PickedFile => entry !== null);
  });

  /** A streaming `media://` URL for an allowlisted file. */
  ipcMain.handle(IPC.mediaUrl, (_event, path: string) => {
    assertAllowed(path);
    return mediaUrlFor(path);
  });

  /**
   * The audio track alone, as a small file the page can decode.
   *
   * Decoding audio means handing the WHOLE encoded file to decodeAudioData,
   * and for a 45-minute video that file is 1.9 GB of mostly pictures. ffmpeg
   * pulls the audio out instead - copied without re-encoding when the codec
   * allows (near instant), transcoded to AAC when it does not - and only that
   * few-dozen-MB file is read by the page. Cached per source for the session.
   */
  ipcMain.handle(IPC.extractAudio, async (_event, path: string): Promise<string | null> => {
    assertAllowed(path);

    const cached = extractedAudio.get(path);
    if (cached) return cached;

    const target = join(tmpdir(), `filmora-audio-${randomUUID()}.m4a`);
    const ffmpeg = resolveFfmpegPath();
    const attempt = (codec: string[]): Promise<boolean> =>
      execFileAsync(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vn', '-map', '0:a:0', ...codec, target], {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }).then(() => true, () => false);

    const ok = (await attempt(['-c:a', 'copy'])) || (await attempt(['-c:a', 'aac', '-b:a', '192k']));
    if (!ok) return null; // No audio track: a silent video, or a still.

    allowedPaths.add(target);
    const url = mediaUrlFor(target);
    extractedAudio.set(path, url);
    return url;
  });

  ipcMain.handle(IPC.openMedia, async (): Promise<PickedFile[]> => {
    const window = getWindow();
    if (!window) return [];

    const result = await dialog.showOpenDialog(window, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media',
          extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS].map((e) =>
            e.slice(1),
          ),
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled) return [];

    const files = await Promise.all(
      result.filePaths.map(async (path) => {
        allowedPaths.add(path);
        // stat, not readFile: this used to read the ENTIRE file just to learn
        // its size - 1.9 GB of a 45-minute recording, held in the main process.
        const info = await stat(path);
        return {
          path,
          name: basename(path),
          kind: classify(path),
          sizeBytes: info.size,
        };
      }),
    );

    return files;
  });

  /**
   * A folder with its subfolders - DaVinci Resolve's "Add Folder and
   * SubFolders into Media Pool (Create Bins)".
   *
   * Every media file under the chosen folder is allowlisted exactly like a
   * file picked in the Import dialog, and comes back with the folders it sits
   * in so the library can mirror them as bins. Hidden entries and links are
   * skipped (a Dirent for a link is neither a file nor a directory), and the
   * walk stops at MAX_FOLDER_DEPTH levels and MAX_FOLDER_FILES files.
   */
  ipcMain.handle(IPC.openMediaFolder, async (): Promise<PickedFile[]> => {
    const window = getWindow();
    if (!window) return [];

    const result = await dialog.showOpenDialog(window, {
      title: 'Add a folder and its subfolders',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];

    return collectMediaFolder(result.filePaths[0]);
  });

  /**
   * Folders dropped from Explorer onto the media panel: the same walk.
   *
   * The paths come from the preload's webUtils.getPathForFile, which only
   * yields a path for a folder the OS handed over, and only existing
   * directories are accepted - the same footing as a file drop.
   */
  ipcMain.handle(IPC.registerDroppedFolders, async (_event, paths: unknown): Promise<PickedFile[]> => {
    if (!Array.isArray(paths)) return [];
    const picked: PickedFile[] = [];
    for (const path of paths) {
      if (typeof path !== 'string' || !isAbsolute(path)) continue;
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) continue;
      await collectMediaFolder(path, picked);
    }
    return picked;
  });

  ipcMain.handle(IPC.openProject, async () => {
    const window = getWindow();
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      title: 'Open project',
      properties: ['openFile'],
      // .scf is the project format since the rename; .fep files from before open too.
      filters: [{ name: 'STOOK CREATOR FILMS project', extensions: ['scf', 'fep', 'json'] }],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const path = result.filePaths[0];
    allowedPaths.add(path);
    const contents = await readFile(path, 'utf8');
    await allowProjectReferences(contents);
    return { path, contents };
  });

  ipcMain.handle(IPC.openLut, async () => {
    const window = getWindow();
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      title: 'Load a .cube LUT',
      properties: ['openFile'],
      filters: [{ name: 'Cube LUT', extensions: ['cube'] }],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const path = result.filePaths[0];
    allowedPaths.add(path);
    return { path, contents: await readFile(path, 'utf8') };
  });

  ipcMain.handle(IPC.saveProjectAs, async (_event, contents: string, suggestedName?: string) => {
    const window = getWindow();
    if (!window) return null;

    const result = await dialog.showSaveDialog(window, {
      title: 'Save project',
      defaultPath: suggestedName ?? 'untitled.scf',
      filters: [{ name: 'STOOK CREATOR FILMS project', extensions: ['scf'] }],
    });

    if (result.canceled || !result.filePath) return null;

    allowedPaths.add(result.filePath);
    await writeFile(result.filePath, contents, 'utf8');
    return result.filePath;
  });

  ipcMain.handle(
    IPC.chooseExportPath,
    async (_event, format: ExportSettings['format']): Promise<string | null> => {
      const window = getWindow();
      if (!window) return null;

      // A PNG sequence needs a folder to write frame_00001.png into.
      if (format === 'png-sequence') {
        const result = await dialog.showOpenDialog(window, {
          title: 'Choose a folder for the PNG sequence',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        allowedPaths.add(result.filePaths[0]);
        return result.filePaths[0];
      }

      const extension =
        format === 'prores4444' ? 'mov' : format === 'webm-vp9' ? 'webm' : 'mp4';

      const result = await dialog.showSaveDialog(window, {
        title: 'Export video',
        defaultPath: `export.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });

      if (result.canceled || !result.filePath) return null;
      allowedPaths.add(result.filePath);
      return result.filePath;
    },
  );

  /**
   * Where exports go unless the user picks somewhere else: Documents\VIDEOS
   * EXPORTADOS, created on first use. Never next to the footage by default -
   * that is how a render once replaced the video it was rendering.
   */
  ipcMain.handle(IPC.defaultExportFolder, async (): Promise<string> => {
    const folder = join(app.getPath('documents'), 'VIDEOS EXPORTADOS');
    await mkdir(folder, { recursive: true });
    allowedFolders.add(folder);
    return folder;
  });

  ipcMain.handle(IPC.chooseExportFolder, async (): Promise<string | null> => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose where to save the export',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    allowedFolders.add(result.filePaths[0]);
    return result.filePaths[0];
  });

  /**
   * Folder + typed name -> the export target.
   *
   * The name comes from a text field, so it is cleaned rather than trusted:
   * characters Windows forbids in file names are replaced, a path separator
   * cannot climb out of the chosen folder, and the extension is the format's -
   * whatever was typed. Only a folder the user picked in the dialog is valid.
   */
  ipcMain.handle(
    IPC.resolveExportTarget,
    async (_event, folder: string, name: string, format: ExportSettings['format']) => {
      if (!allowedFolders.has(folder)) throw new Error('Choose the export folder first');
      const base = sanitizeFileName(name) || 'export';
      const path = join(folder, format === 'png-sequence' ? base : `${base}.${extensionFor(format)}`);
      allowedPaths.add(path);
      const exists = Boolean(await stat(path).catch(() => null));
      return { path, exists, inUse: isOpenMediaPath(path) };
    },
  );

  ipcMain.handle(IPC.chooseThumbnail, async (): Promise<string | null> => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a thumbnail image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    allowedPaths.add(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.writeThumbnail, async (_event, png: ArrayBuffer) => {
    const path = join(tmpdir(), `scf-thumbnail-${randomUUID()}.png`);
    await writeFile(path, Buffer.from(png));
    allowedPaths.add(path);
    return path;
  });

  ipcMain.handle(IPC.readFile, async (_event, path: string) => {
    assertAllowed(path);
    const buffer = await readFile(path);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });

  ipcMain.handle(IPC.readTextFile, async (_event, path: string) => {
    assertAllowed(path);
    return readFile(path, 'utf8');
  });

  ipcMain.handle(IPC.writeTextFile, async (_event, path: string, contents: string) => {
    assertAllowed(path);
    await writeFile(path, contents, 'utf8');
  });

  ipcMain.handle(IPC.probeMedia, (_event, path: string) => probeMedia(path));

  ipcMain.handle(IPC.detectEncoders, () => detectHardwareEncoders());

  ipcMain.handle(IPC.gpuReport, () => getGpuReport());

  ipcMain.handle(IPC.setGpuPreference, (_event, preference: unknown) => {
    // Validated here, not trusted from the renderer: this value becomes a
    // command-line switch on the next launch.
    if (!isGpuPreference(preference)) throw new Error(`Unknown GPU preference "${String(preference)}"`);
    writeGpuPreference(preference);
  });

  ipcMain.handle(IPC.relaunch, () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle(IPC.writeExportAudio, async (_event, wav: ArrayBuffer) => {
    // ffmpeg takes audio as a file input, so the mix has to land on disk before
    // the encoder is spawned. Temp files are cleaned up when the job finishes.
    const path = join(tmpdir(), `filmora-mix-${randomUUID()}.wav`);
    await writeFile(path, Buffer.from(wav));
    allowedPaths.add(path);
    return path;
  });

  /**
   * A streamed mix: raw float32 appended a piece at a time.
   *
   * The single WAV above means the whole mix exists at once - in the page,
   * again as the WAV, and again here: an hour of stereo float is 1.4 GB
   * each time, and an hour-long export peaked at 5.3 GB in the page and
   * 1.4 GB in this process. Pieces of a minute keep both near nothing.
   */
  const openMixes = new Map<string, FileHandle>();

  ipcMain.handle(IPC.exportAudioOpen, async () => {
    const path = join(tmpdir(), `filmora-mix-${randomUUID()}.f32le`);
    openMixes.set(path, await open(path, 'w'));
    allowedPaths.add(path);
    return path;
  });

  ipcMain.handle(IPC.exportAudioAppend, async (_event, path: string, samples: ArrayBuffer) => {
    const handle = openMixes.get(path);
    if (!handle) throw new Error('That audio mix is not open');
    await handle.write(new Uint8Array(samples));
  });

  ipcMain.handle(IPC.exportAudioClose, async (_event, path: string, discard?: boolean) => {
    const handle = openMixes.get(path);
    openMixes.delete(path);
    await handle?.close();
    if (discard) {
      allowedPaths.delete(path);
      await rm(path, { force: true });
    }
  });

  ipcMain.handle(IPC.exportStart, async (_event, settings: ExportSettings) => {
    assertAllowed(settings.outputPath);
    // Never render over footage the project is reading from. The dialog warns
    // first; this is the line that makes it impossible.
    if (settings.format !== 'png-sequence' && isOpenMediaPath(settings.outputPath)) {
      throw new Error(
        'That file is in this project as source footage. Exporting onto it would destroy it - choose another name or folder.',
      );
    }
    if (settings.audioPath) assertAllowed(settings.audioPath);
    if (settings.thumbnailPath) assertAllowed(settings.thumbnailPath);
    return { jobId: await pipeline.start(settings) };
  });

  ipcMain.handle(IPC.exportFrame, (_event, jobId: string, rgba: ArrayBuffer) =>
    pipeline.writeFrame(jobId, new Uint8Array(rgba)),
  );

  ipcMain.handle(IPC.exportFinish, (_event, jobId: string) => pipeline.finish(jobId));

  ipcMain.handle(IPC.exportCancel, (_event, jobId: string) => pipeline.cancel(jobId));

  return pipeline;
}

/** Exposed for tests and for re-opening recent files. */
export const allowPath = (path: string): void => {
  allowedPaths.add(path);
};
