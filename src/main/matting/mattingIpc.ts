import { app, ipcMain, net, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { MATTE_MODEL_IDS, type MatteModelId } from '@shared/types';
import { IPC, type MatteBuildRequest, type MatteEngineStatus, type MatteModelProgress, type MattePartial, type MatteProgressEvent } from '@shared/types/ipc';
import { MATTE_HEADER_BYTES, matteSize } from '@shared/matte/format';
import { resolveFfmpegPath } from '../exporter/HardwareAccel';
import { assertAllowedPath } from '../ipc/fileSystem';
import { mediaUrlFor } from '../ipc/mediaProtocol';
import { mt } from '../language';
import { ChecksumError, deleteModel, downloadModel, isModelReady, modelPath } from '../subtitles/models';
import { MATTE_MODELS, matteModelById } from './catalog';
import { deviceOverride, describeDevice, type MatteDevice } from './device';
import type { FromWorker, MatteJob, ToWorker } from './job';
import { MatteFolder } from './matteStore';

/**
 * Remove background, from the page: the models, and analysing a file into
 * its mattes.
 *
 * The network is touched only by `mattesModelDownload`, which the page calls
 * once the person has agreed to it, and which fetches one of the two files in
 * the catalogue - nothing is sent but the request for it. Analysis runs in a
 * utility process (worker.ts), one file at a time: two models on one GPU
 * would each run at half speed and could run it out of memory.
 */

const modelsDir = (): string => process.env.SCF_MATTE_MODELS_DIR || join(app.getPath('userData'), 'matte-models');

/** Bundled beside this file by Vite (vite.config.ts). */
const workerPath = (): string => join(__dirname, 'matteWorker.js');

const isModelId = (value: unknown): value is MatteModelId => (MATTE_MODEL_IDS as readonly unknown[]).includes(value);

interface Running {
  key: string;
  model: MatteModelId;
  promise: Promise<string | null>;
  cancel(): void;
  /**
   * The frames finished so far, in the temporary file at `url`, once the
   * analysis has started: frame i is the bytes [offsets[i], offsets[i + 1]).
   */
  partial(): PartialFile | null;
}

interface PartialFile {
  url: string;
  width: number;
  height: number;
  fps: number;
  offsets: number[];
}

/** A partial URL as the page holds it, with its revision and marks taken off. */
const bareUrl = (url: string): string => url.split(/[?#]/)[0];

export function registerMattingHandlers(getWindow: () => BrowserWindow | null): { cancelAll(): void } {
  // SCF_MATTE_SMOOTHING=off keeps the model's own output, for measuring the smoothing (matteStore.ts).
  const smoothing = process.env.SCF_MATTE_SMOOTHING !== 'off';
  const folder = new MatteFolder(join(app.getPath('userData'), 'scf', 'mattes'), smoothing);
  void folder.sweepLeftovers();

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  /**
   * The device the first analysis measured, kept for the rest of the
   * session so the probe runs once. SCF_MATTE_DEVICE overrides it.
   */
  let device: MatteDevice | null = deviceOverride(process.env.SCF_MATTE_DEVICE);
  const deviceKind = (): 'gpu' | 'cpu' | null => (device ? (device.kind === 'dml' ? 'gpu' : 'cpu') : null);

  const status = async (): Promise<MatteEngineStatus> => ({
    available: existsSync(workerPath()),
    device: deviceKind(),
    models: await Promise.all(
      MATTE_MODELS.map(async (model) => {
        const present = await isModelReady(modelsDir(), model);
        // What the file really takes on disk, not the catalogue's figure.
        const onDisk = present ? await stat(modelPath(modelsDir(), model)).catch(() => null) : null;
        return { id: model.id, bytes: model.bytes, present, fileBytes: onDisk?.size ?? 0, source: model.source, licence: model.licence };
      }),
    ),
    cache: await folder.usage(),
    analysing: [...new Set([...jobs.values()].map((job) => job.model))],
  });

  ipcMain.handle(IPC.mattesStatus, () => status());

  /* Models ---------------------------------------------------------------------- */

  const downloads = new Map<MatteModelId, AbortController>();

  ipcMain.handle(IPC.mattesModelDownload, async (_event, id: unknown): Promise<MatteEngineStatus> => {
    const model = matteModelById(id);
    if (!model) throw new Error(mt('mattes.errorUnknownModel'));
    if (downloads.has(model.id)) throw new Error(mt('captions.errorAlreadyDownloading'));
    const controller = new AbortController();
    downloads.set(model.id, controller);
    let lastSent = 0;
    try {
      // As with the speech models: the tests serve the same file from this
      // computer. Never in an installed app, and the hash is checked either way.
      const base = app.isPackaged ? undefined : process.env.SCF_MATTE_MODEL_BASE;
      await downloadModel(modelsDir(), base ? { ...model, url: `${base}/${model.file}` } : model, {
        fetch: (url, init) => net.fetch(url, init),
        signal: controller.signal,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastSent < 150 && received < total) return;
          lastSent = now;
          send(IPC.mattesModelProgress, { id: model.id, received, total } satisfies MatteModelProgress);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return status();
      if (error instanceof ChecksumError) throw new Error(mt('captions.errorChecksum'));
      throw new Error(mt('mattes.errorDownload', { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      downloads.delete(model.id);
    }
    return status();
  });

  ipcMain.handle(IPC.mattesModelCancel, (_event, id: unknown) => {
    const model = matteModelById(id);
    if (model) downloads.get(model.id)?.abort();
  });

  /**
   * Delete a model from this computer. Refused, never forced, while an
   * analysis runs or waits with it, or while it is downloading: the person
   * cancels that first and knows what they stopped. Afterwards the effect
   * asks to download it again, as on a computer that never had it.
   */
  ipcMain.handle(IPC.mattesModelDelete, async (_event, id: unknown): Promise<MatteEngineStatus> => {
    const model = matteModelById(id);
    if (!model) throw new Error(mt('mattes.errorUnknownModel'));
    if (downloads.has(model.id)) throw new Error(mt('mattes.errorBusyDownload'));
    if ([...jobs.values()].some((job) => job.model === model.id)) throw new Error(mt('mattes.errorBusyModel'));
    await deleteModel(modelsDir(), model);
    return status();
  });

  /* Mattes ---------------------------------------------------------------------- */

  ipcMain.handle(IPC.mattesFind, async (_event, path: unknown, model: unknown) => {
    if (typeof path !== 'string' || !isModelId(model)) return null;
    assertAllowedPath(path);
    const found = await folder.find(path, model);
    return found ? mediaUrlFor(found.file) : null;
  });

  ipcMain.handle(IPC.mattesDelete, async (_event, path: unknown, model: unknown) => {
    if (typeof path !== 'string' || !isModelId(model)) return;
    assertAllowedPath(path);
    const found = await folder.find(path, model);
    if (found) await rm(found.file, { force: true });
  });

  /**
   * Throw every matte away. Refused while any analysis runs or waits: its
   * temporary file is in the same folder, and the page may be reading its
   * finished frames. Every clip is analysed again when next it needs to be.
   */
  ipcMain.handle(IPC.mattesClearCache, async (): Promise<MatteEngineStatus> => {
    if (jobs.size > 0) throw new Error(mt('mattes.errorBusyCache'));
    await folder.clear();
    return status();
  });

  /** By `path|model`: the analysis running or waiting for it. */
  const jobs = new Map<string, Running>();
  /** Analyses wait for the one before them. */
  let queue: Promise<unknown> = Promise.resolve();

  const runWorker = (job: MatteJob, onMessage: (message: FromWorker) => void, setCancel: (cancel: () => void) => void): Promise<'done' | 'cancelled'> =>
    new Promise((resolve, reject) => {
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(workerPath(), [], { serviceName: 'SCF background removal', stdio: 'pipe' });
      } catch (error) {
        reject(error);
        return;
      }
      // Settled only once the process has gone, not on its last message:
      // until it exits it may still hold the model file open, and the model
      // can be deleted from Preferences the moment the analysis is over.
      let outcome: { kind: 'done' | 'cancelled' } | { kind: 'error'; error: Error } | null = null;
      let lingering: ReturnType<typeof setTimeout> | null = null;
      let complaint = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        complaint = `${complaint}${chunk.toString('utf8')}`.slice(-2000);
      });
      child.stdout?.on('data', (chunk: Buffer) => console.info(`[matte] ${chunk.toString('utf8').trim()}`));
      setCancel(() => child.postMessage({ type: 'cancel' } satisfies ToWorker));
      child.on('message', (message: FromWorker) => {
        onMessage(message);
        if (outcome) return;
        if (message.type === 'done' || message.type === 'cancelled') outcome = { kind: message.type };
        else if (message.type === 'error') outcome = { kind: 'error', error: new Error(message.message) };
        else return;
        // It exits straight after; one that does not is not waited on for ever.
        lingering = setTimeout(() => child.kill(), 5000);
      });
      child.on('exit', (code) => {
        if (lingering) clearTimeout(lingering);
        if (outcome?.kind === 'error') reject(outcome.error);
        else if (outcome) resolve(outcome.kind);
        else reject(new Error(complaint.trim().split(/\r?\n/).slice(-2).join(' / ') || `exit ${code}`));
      });
      child.postMessage({ type: 'start', job } satisfies ToWorker);
    });

  ipcMain.handle(IPC.mattesBuild, async (_event, raw: unknown): Promise<string | null> => {
    const request = raw as Partial<MatteBuildRequest> | null;
    if (!request || typeof request.path !== 'string' || !isModelId(request.model)) throw new Error(mt('mattes.errorUnknownModel'));
    const { path, model: modelId } = request;
    assertAllowedPath(path);
    const model = matteModelById(modelId);
    if (!model) throw new Error(mt('mattes.errorUnknownModel'));
    if (!(await isModelReady(modelsDir(), model))) throw new Error(mt('mattes.errorNoModel'));

    const existing = await folder.find(path, modelId);
    if (existing) return mediaUrlFor(existing.file);

    const id = `${path}|${modelId}`;
    const running = jobs.get(id);
    if (running) return running.promise;

    const key = await folder.keyFor(path, modelId);
    if (!key) throw new Error(mt('main.accessDenied', { name: path }));
    await folder.ensure();

    const width = Number(request.width) || 0;
    const height = Number(request.height) || 0;
    const still = request.still === true;
    const fps = still ? 1 : Number(request.fps) > 0 ? Number(request.fps) : 30;
    const size = matteSize(width, height);
    let cancelled = false;
    let cancelWorker: (() => void) | null = null;
    let partial: PartialFile | null = null;

    const progress = (done: number, total: number, msPerFrame: number): void =>
      send(IPC.mattesProgress, {
        path,
        model: modelId,
        done,
        total,
        msPerFrame,
        device: deviceKind(),
        partialUrl: partial && partial.offsets.length > 1 ? partial.url : null,
      } satisfies MatteProgressEvent);

    const promise = (async (): Promise<string | null> => {
      // Wait for the analysis before this one; it failing is not this one's business.
      const turn = queue.catch(() => undefined);
      let release: () => void = () => undefined;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await turn;
      try {
        if (cancelled) return null;
        progress(0, Math.max(1, Math.round((Number(request.seconds) || 0) * fps)), 0);
        const job: MatteJob = {
          ffmpeg: resolveFfmpegPath(),
          source: path,
          still,
          fps,
          expectedFrames: still ? 1 : Math.max(1, Math.round((Number(request.seconds) || 0) * fps)),
          sourceWidth: width,
          sourceHeight: height,
          matteWidth: size.width,
          matteHeight: size.height,
          model,
          modelPath: modelPath(modelsDir(), model),
          part: folder.partFor(key),
          target: folder.fileFor(key),
          device,
          // Half the processor at most, as captions do: the editor has to stay usable.
          threads: Math.max(1, Math.floor(cpus().length / 2)),
          smoothing,
        };
        partial = { url: mediaUrlFor(job.part), width: size.width, height: size.height, fps, offsets: [MATTE_HEADER_BYTES] };
        const outcome = await runWorker(
          job,
          (message) => {
            if (message.type === 'device') {
              device = message.device;
              console.info(`[matte] ${describeDevice(message.device)}${message.probe ? ` (probe ${JSON.stringify(message.probe)})` : ''}`);
            } else if (message.type === 'written') {
              partial?.offsets.push(message.end);
            } else if (message.type === 'progress') {
              progress(message.done, message.total, message.msPerFrame);
            } else if (message.type === 'done') {
              console.info(`[matte] ${message.frames} frames, ${message.bytes} bytes, ${message.msPerFrame.toFixed(1)} ms/frame in the model; ${JSON.stringify(message.timings)}`);
            }
          },
          (cancel) => {
            cancelWorker = cancel;
            if (cancelled) cancel();
          },
        );
        if (outcome === 'cancelled') return null;
        const found = await folder.find(path, modelId);
        return found ? mediaUrlFor(found.file) : null;
      } catch (error) {
        throw new Error(mt('mattes.errorAnalysis', { detail: error instanceof Error ? error.message : String(error) }));
      } finally {
        jobs.delete(id);
        release();
      }
    })();

    jobs.set(id, {
      key,
      model: modelId,
      promise,
      cancel: () => {
        cancelled = true;
        cancelWorker?.();
      },
      partial: () => partial,
    });
    return promise;
  });

  ipcMain.handle(IPC.mattesPartial, (_event, url: unknown, from: unknown): MattePartial | null => {
    if (typeof url !== 'string') return null;
    const wanted = bareUrl(url);
    for (const job of jobs.values()) {
      const file = job.partial();
      if (!file || file.url !== wanted) continue;
      const start = Math.max(0, Math.floor(Number(from) || 0));
      return { width: file.width, height: file.height, fps: file.fps, offsets: file.offsets.slice(start) };
    }
    return null;
  });

  ipcMain.handle(IPC.mattesCancel, (_event, path: unknown, model: unknown) => {
    if (typeof path !== 'string' || !isModelId(model)) return;
    jobs.get(`${path}|${model}`)?.cancel();
  });

  return {
    cancelAll: () => {
      for (const job of jobs.values()) job.cancel();
    },
  };
}
