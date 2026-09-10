import { BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import type { ExportSettings, MediaKind } from '@shared/types';
import { IPC, type MediaProbe, type PickedFile } from '@shared/types/ipc';
import { EncoderPipeline } from '../exporter/EncoderPipeline';
import { detectHardwareEncoders, resolveFfmpegPath } from '../exporter/HardwareAccel';

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

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  duration?: string;
}

/** ffprobe ships alongside ffmpeg in most builds; fall back to the same dir. */
function resolveFfprobePath(): string {
  const ffmpeg = resolveFfmpegPath();
  return ffmpeg === 'ffmpeg' ? 'ffprobe' : ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

/** Pixel formats whose names encode an alpha plane. */
const hasAlphaPixelFormat = (pixelFormat: string | undefined): boolean =>
  pixelFormat !== undefined && /a$|^(yuva|rgba|bgra|argb|abgr|gbrap|pal8)/i.test(pixelFormat);

async function probeMedia(path: string): Promise<MediaProbe> {
  assertAllowed(path);

  const fallback: MediaProbe = {
    path,
    durationSeconds: 0,
    width: 0,
    height: 0,
    fps: 30,
    hasAlphaChannel: IMAGE_EXTENSIONS.has(extname(path).toLowerCase()),
    hasAudio: false,
    codec: 'unknown',
  };

  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path,
    ]);

    const parsed = JSON.parse(stdout) as {
      streams?: FfprobeStream[];
      format?: { duration?: string };
    };

    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');

    const [numerator, denominator] = (video?.r_frame_rate ?? '30/1').split('/').map(Number);
    const fps = denominator > 0 ? numerator / denominator : 30;

    return {
      path,
      durationSeconds: Number(parsed.format?.duration ?? video?.duration ?? 0),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
      hasAlphaChannel: hasAlphaPixelFormat(video?.pix_fmt),
      hasAudio: audio !== undefined,
      codec: video?.codec_name ?? audio?.codec_name ?? 'unknown',
    };
  } catch {
    // ffprobe is best-effort: an un-probeable file still imports, the renderer
    // just falls back to element metadata.
    return fallback;
  }
}

export function registerFileSystemHandlers(getWindow: () => BrowserWindow | null): EncoderPipeline {
  const pipeline = new EncoderPipeline((progress) => {
    getWindow()?.webContents.send(IPC.exportProgress, progress);
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
        const contents = await readFile(path);
        return {
          path,
          name: basename(path),
          kind: classify(path),
          sizeBytes: contents.byteLength,
        };
      }),
    );

    return files;
  });

  ipcMain.handle(IPC.openProject, async () => {
    const window = getWindow();
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'Filmora Engine project', extensions: ['fep', 'json'] }],
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
      defaultPath: suggestedName ?? 'untitled.fep',
      filters: [{ name: 'Filmora Engine project', extensions: ['fep'] }],
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

  ipcMain.handle(IPC.exportStart, async (_event, settings: ExportSettings) => {
    assertAllowed(settings.outputPath);
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
