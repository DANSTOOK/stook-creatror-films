import { BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ExportSettings, MediaKind } from '@shared/types';
import { IPC, type MediaProbe, type PickedFile } from '@shared/types/ipc';
import { snapFrameRate } from '@shared/utils/frameRate';
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

  ipcMain.handle(IPC.writeExportAudio, async (_event, wav: ArrayBuffer) => {
    // ffmpeg takes audio as a file input, so the mix has to land on disk before
    // the encoder is spawned. Temp files are cleaned up when the job finishes.
    const path = join(tmpdir(), `filmora-mix-${randomUUID()}.wav`);
    await writeFile(path, Buffer.from(wav));
    allowedPaths.add(path);
    return path;
  });

  ipcMain.handle(IPC.exportStart, async (_event, settings: ExportSettings) => {
    assertAllowed(settings.outputPath);
    if (settings.audioPath) assertAllowed(settings.audioPath);
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
