import { app, dialog, ipcMain, net, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  IPC,
  type CaptionEngineStatus,
  type CaptionModelId,
  type CaptionModelProgress,
  type CaptionProgressEvent,
  type CaptionTranscribeRequest,
  type CaptionTranscribeResult,
} from '@shared/types/ipc';
import { resolveFfmpegPath } from '../exporter/HardwareAccel';
import { allowPath, isFinishedExport } from '../ipc/fileSystem';
import { lastLines, mt } from '../language';
import { CAPTION_MODELS, MODEL_SOURCE, modelById } from './catalog';
import { findEngine, type WhisperEngine } from './engine';
import { ChecksumError, deleteModel, downloadModel, importModel, isModelReady, modelPath } from './models';
import { Transcriber, TranscriptionError } from './transcriber';

/**
 * Captions, from the page: the engine's state, the models, transcription
 * jobs, and reading and writing subtitle files.
 *
 * The only thing here that touches the network is `captionsModelDownload`,
 * which the page calls after the person has agreed to it, and which fetches
 * one of the two files in the catalogue from Hugging Face - nothing is sent
 * but the request for the file.
 */

/** Models live with the app's other data, not in the project and not in the installer. */
const modelsDir = (): string => process.env.SCF_WHISPER_MODELS_DIR || join(app.getPath('userData'), 'whisper-models');

let engine: WhisperEngine | null | undefined;
const currentEngine = (): WhisperEngine | null => {
  if (engine === undefined) {
    engine = findEngine({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, appPath: app.isPackaged ? undefined : app.getAppPath() });
  }
  return engine;
};

export function registerSubtitleHandlers(getWindow: () => BrowserWindow | null): Transcriber {
  const transcriber = new Transcriber({
    tempRoot: join(app.getPath('temp'), 'scf-captions'),
    ffmpegPath: resolveFfmpegPath,
    engine: currentEngine,
  });
  // Whatever a crashed session left behind.
  void transcriber.sweep();

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const status = async (): Promise<CaptionEngineStatus> => {
    const found = currentEngine();
    const gpu = found ? await transcriber.chooseGpu() : null;
    return {
      available: found !== null,
      vulkan: found?.vulkan === true,
      gpu: gpu && gpu !== 'auto' ? gpu.name : null,
      vad: Boolean(found?.vadModel),
      models: await Promise.all(
        CAPTION_MODELS.map(async (model) => ({
          id: model.id,
          file: model.file,
          bytes: model.bytes,
          present: await isModelReady(modelsDir(), model),
          source: MODEL_SOURCE,
        })),
      ),
    };
  };

  ipcMain.handle(IPC.captionsStatus, () => status());

  /* Models -------------------------------------------------------------------- */

  const downloads = new Map<CaptionModelId, AbortController>();

  ipcMain.handle(IPC.captionsModelDownload, async (_event, id: unknown): Promise<CaptionEngineStatus> => {
    const model = modelById(id);
    if (!model) throw new Error(mt('captions.errorUnknownModel'));
    if (downloads.has(model.id)) throw new Error(mt('captions.errorAlreadyDownloading'));
    const controller = new AbortController();
    downloads.set(model.id, controller);
    let lastSent = 0;
    try {
      // The tests serve the same file from this computer, to exercise the
      // download without fetching half a gigabyte each run. Never in an
      // installed app - and wherever it comes from, the file still has to
      // match the SHA-256 fixed in the catalogue.
      const base = app.isPackaged ? undefined : process.env.SCF_WHISPER_MODEL_BASE;
      await downloadModel(modelsDir(), base ? { ...model, url: `${base}/${model.file}` } : model, {
        // Chromium's network stack: the system's proxy settings apply.
        fetch: (url, init) => net.fetch(url, init),
        signal: controller.signal,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastSent < 150 && received < total) return;
          lastSent = now;
          send(IPC.captionsModelProgress, { id: model.id, received, total } satisfies CaptionModelProgress);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return status();
      if (error instanceof ChecksumError) throw new Error(mt('captions.errorChecksum'));
      throw new Error(mt('captions.errorDownload', { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      downloads.delete(model.id);
    }
    return status();
  });

  ipcMain.handle(IPC.captionsModelCancel, (_event, id: unknown) => {
    const model = modelById(id);
    if (model) downloads.get(model.id)?.abort();
  });

  ipcMain.handle(IPC.captionsModelImport, async (): Promise<CaptionEngineStatus | null> => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: mt('captions.importModelTitle'),
      properties: ['openFile'],
      filters: [{ name: mt('captions.filterModel'), extensions: ['bin'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      await importModel(modelsDir(), result.filePaths[0]);
    } catch (error) {
      if (error instanceof ChecksumError) throw new Error(mt('captions.errorNotAModel'));
      throw error;
    }
    return status();
  });

  ipcMain.handle(IPC.captionsModelDelete, async (_event, id: unknown): Promise<CaptionEngineStatus> => {
    const model = modelById(id);
    if (model) await deleteModel(modelsDir(), model);
    return status();
  });

  /* Transcription ---------------------------------------------------------------- */

  ipcMain.handle(IPC.captionsAudioOpen, () => transcriber.openAudio());

  ipcMain.handle(IPC.captionsAudioAppend, (_event, jobId: string, samples: ArrayBuffer) => transcriber.appendAudio(jobId, new Uint8Array(samples)));

  ipcMain.handle(IPC.captionsAudioClose, async (_event, jobId: string) => {
    try {
      await transcriber.closeAudio(jobId);
    } catch (error) {
      throw new Error(mt('captions.errorAudio', { detail: error instanceof TranscriptionError ? error.detail : String(error) }));
    }
  });

  ipcMain.handle(IPC.captionsTranscribe, async (_event, jobId: string, request: CaptionTranscribeRequest): Promise<CaptionTranscribeResult> => {
    const model = modelById(request?.model);
    if (!model) throw new Error(mt('captions.errorUnknownModel'));
    const language = request.language === 'en' ? 'en' : 'es';
    if (!(await isModelReady(modelsDir(), model))) {
      await transcriber.cancel(jobId);
      throw new Error(mt('captions.errorNoModel'));
    }
    try {
      return await transcriber.transcribe(
        jobId,
        model,
        modelPath(modelsDir(), model),
        language,
        (fraction) => send(IPC.captionsProgress, { jobId, fraction } satisfies CaptionProgressEvent),
        { prompt: typeof request.prompt === 'string' ? request.prompt : '', vad: request.vad !== false },
      );
    } catch (error) {
      if (error instanceof TranscriptionError) {
        throw new Error(mt(error.kind === 'no-job' ? 'captions.errorNoJob' : 'captions.errorEngine', { detail: lastLines(error.detail) }));
      }
      throw error;
    }
  });

  ipcMain.handle(IPC.captionsCancel, (_event, jobId: string) => transcriber.cancel(jobId));

  /* Subtitle files ---------------------------------------------------------------- */

  ipcMain.handle(IPC.captionsOpenFile, async (): Promise<{ path: string; contents: string } | null> => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: mt('captions.importTitle'),
      properties: ['openFile'],
      filters: [{ name: mt('captions.filterSubtitles'), extensions: ['srt', 'vtt'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const path = result.filePaths[0];
    return { path, contents: await readFile(path, 'utf8') };
  });

  ipcMain.handle(IPC.captionsSaveFile, async (_event, suggestedName: unknown, srt: unknown, vtt: unknown): Promise<string | null> => {
    const window = getWindow();
    if (!window || typeof srt !== 'string' || typeof vtt !== 'string') return null;
    const result = await dialog.showSaveDialog(window, {
      title: mt('captions.exportTitle'),
      defaultPath: typeof suggestedName === 'string' && suggestedName ? suggestedName : 'captions.srt',
      filters: [
        { name: 'SubRip (.srt)', extensions: ['srt'] },
        { name: 'WebVTT (.vtt)', extensions: ['vtt'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    // The extension chosen in the dialog decides the format.
    const isVtt = extname(result.filePath).toLowerCase() === '.vtt';
    await writeFile(result.filePath, isVtt ? vtt : srt, 'utf8');
    return result.filePath;
  });

  /**
   * The subtitle file that goes with an export: beside the video, with its
   * name. Only for a file this session rendered to the end, so the page
   * cannot write anywhere it likes.
   */
  ipcMain.handle(IPC.captionsWriteSidecar, async (_event, videoPath: unknown, format: unknown, contents: unknown): Promise<string> => {
    if (typeof videoPath !== 'string' || !isFinishedExport(videoPath) || typeof contents !== 'string') throw new Error(mt('main.onlyExported'));
    const extension = format === 'vtt' ? '.vtt' : '.srt';
    const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
    // A PNG sequence is a folder: the file goes inside it.
    const target = extname(videoPath) === '' ? join(videoPath, `captions${extension}`) : `${base}${extension}`;
    await writeFile(target, contents, 'utf8');
    return target;
  });

  /**
   * The subtitles that go INSIDE an export, as a file for ffmpeg to read: a
   * temporary .srt the export deletes when it ends (EncoderPipeline), as it
   * does the audio mix.
   */
  ipcMain.handle(IPC.captionsWriteTemp, async (_event, srt: unknown): Promise<string> => {
    if (typeof srt !== 'string') throw new Error(mt('main.nothingToWrite'));
    const path = join(tmpdir(), `scf-captions-${randomUUID()}.srt`);
    await writeFile(path, srt, 'utf8');
    allowPath(path);
    return path;
  });

  return transcriber;
}
