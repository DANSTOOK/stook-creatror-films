import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  IPC,
  type TtsEngineStatus,
  type TtsProgressEvent,
  type TtsRequest,
  type TtsResult,
  type TtsVoiceId,
  type TtsVoiceProgress,
} from '@shared/types/ipc';
import { allowPath } from '../ipc/fileSystem';
import { mt } from '../language';
import { ChecksumError } from '../subtitles/models';
import { ALL_VOICES, BUNDLED_VOICES, VOICE_SOURCE, voiceById, type TtsVoice } from './catalog';
import { previewScript } from '@shared/tts/script';
import { findEngine, findKokoroEngine, kokoroEngineIn, type PiperEngine } from './engine';
import { TTS_EFFECTS } from './finish';
import { Synthesizer, SynthError } from './synth';
import { deleteVoice, downloadVoice, isVoiceReady, voiceModelPath, type VoiceDirs } from './voices';
import { finishVoice } from './finish';
import { readWav } from './wav';
import { resolveFfmpegPath } from '../exporter/HardwareAccel';

/**
 * Text to speech, from the page: the engine's state, the voices, previews and
 * generation jobs. The only thing here that touches the network is
 * `ttsVoiceDownload`, which the page calls after the person has agreed, and
 * which fetches one optional voice from Hugging Face - nothing is sent but the
 * request for the file, and whatever comes back is checked against its fixed
 * SHA-256 before it is ever run.
 *
 * Piper (the engine) controls pace but not pitch, and its chosen voices carry
 * no use restrictions, so `disclosureRequired` is false. The field exists so
 * that if the bundled engine were ever swapped for one whose licence requires
 * disclosing machine-generated audio (e.g. an OpenRAIL-M model), the panel and
 * the licences dialog can surface that obligation without further plumbing.
 */

/** Downloaded voices live with the app's other data, not in the installer. */
const downloadedDir = (): string => process.env.SCF_TTS_VOICES_DIR || join(app.getPath('userData'), 'tts-voices');

/** Bundled voices: resources/tts-voices when packaged, build/tts-voices in a checkout. */
function bundledDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.SCF_TTS_BUNDLED_DIR) dirs.push(process.env.SCF_TTS_BUNDLED_DIR);
  if (app.isPackaged) dirs.push(join(process.resourcesPath, 'tts-voices'));
  else dirs.push(join(app.getAppPath(), 'build', 'tts-voices'));
  return dirs;
}

const dirs = (): VoiceDirs => ({ bundled: bundledDirs(), downloaded: downloadedDir() });

let engine: PiperEngine | null | undefined;
const currentEngine = (): PiperEngine | null => {
  if (engine === undefined) {
    engine = findEngine({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, appPath: app.isPackaged ? undefined : app.getAppPath() });
  }
  return engine;
};

let kokoroEngine: PiperEngine | null | undefined;
const currentKokoro = (): { engine: PiperEngine; espeakData: string } | null => {
  const piper = currentEngine();
  if (kokoroEngine === undefined) {
    // Where it is installed or built, or else beside Piper's folder, where both are staged.
    kokoroEngine =
      findKokoroEngine({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, appPath: app.isPackaged ? undefined : app.getAppPath() }) ??
      (piper ? kokoroEngineIn(join(dirname(piper.dir), 'sherpa-onnx')) : null);
  }
  // Kokoro reads espeak-ng's data from beside Piper: the same files, shipped once.
  return kokoroEngine && piper ? { engine: kokoroEngine, espeakData: join(piper.dir, 'espeak-ng-data') } : null;
};

/** Whether the program that speaks `voice` is here. */
const engineFor = (voice: TtsVoice): boolean => (voice.engine === 'kokoro' ? currentKokoro() !== null : currentEngine() !== null);

/** A character the page may ask for, or none. */
const effectOf = (value: unknown): TtsRequest['effect'] => (TTS_EFFECTS.includes(value as never) ? (value as TtsRequest['effect']) : 'none');

export function registerTtsHandlers(getWindow: () => BrowserWindow | null): Synthesizer {
  const synth = new Synthesizer({ tempRoot: join(app.getPath('temp'), 'scf-tts'), engine: currentEngine, kokoro: currentKokoro });
  void synth.sweep();

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const status = async (): Promise<TtsEngineStatus> => {
    const places = dirs();
    const available = currentEngine() !== null || currentKokoro() !== null;
    return {
      available,
      supportsPitch: true,
      disclosureRequired: false,
      voiceSource: VOICE_SOURCE,
      voices: await Promise.all(
        ALL_VOICES.map(async (voice) => ({
          id: voice.id,
          engine: voice.engine,
          name: voice.name,
          persona: voice.persona,
          language: voice.language,
          region: voice.region,
          sex: voice.sex,
          licence: voice.licence,
          bundled: voice.onnx === null,
          present: engineFor(voice) && (await isVoiceReady(voice, places)),
          downloadBytes: voice.onnx ? voice.onnx.bytes + (voice.json?.bytes ?? 0) : 0,
        })),
      ),
    };
  };

  ipcMain.handle(IPC.ttsStatus, () => status());

  /* Voices -------------------------------------------------------------------- */

  const downloads = new Map<TtsVoiceId, AbortController>();

  ipcMain.handle(IPC.ttsVoiceDownload, async (_event, id: unknown): Promise<TtsEngineStatus> => {
    const voice = voiceById(id);
    if (!voice || !voice.onnx) throw new Error(mt('tts.errorUnknownVoice'));
    if (downloads.has(voice.id)) throw new Error(mt('tts.errorAlreadyDownloading'));
    const controller = new AbortController();
    downloads.set(voice.id, controller);
    let lastSent = 0;
    try {
      await downloadVoice(voice, dirs(), {
        fetch: (url, init) => net.fetch(url, init),
        signal: controller.signal,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastSent < 150 && received < total) return;
          lastSent = now;
          send(IPC.ttsVoiceProgress, { id: voice.id, received, total } satisfies TtsVoiceProgress);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return status();
      if (error instanceof ChecksumError) throw new Error(mt('tts.errorChecksum'));
      throw new Error(mt('tts.errorDownload', { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      downloads.delete(voice.id);
    }
    return status();
  });

  ipcMain.handle(IPC.ttsVoiceCancel, (_event, id: unknown) => {
    const voice = voiceById(id);
    if (voice) downloads.get(voice.id)?.abort();
  });

  ipcMain.handle(IPC.ttsVoiceDelete, async (_event, id: unknown): Promise<TtsEngineStatus> => {
    const voice = voiceById(id);
    if (voice && voice.onnx) await deleteVoice(voice, dirs());
    return status();
  });

  /* Preview and generation ------------------------------------------------------ */

  const prepare = async (request: TtsRequest): Promise<{ voice: TtsVoice; model: string }> => {
    const voice = voiceById(request?.voice) ?? BUNDLED_VOICES.find(engineFor) ?? BUNDLED_VOICES[0];
    if (!engineFor(voice) || !(await isVoiceReady(voice, dirs()))) throw new Error(mt('tts.errorNoVoice'));
    const model = voiceModelPath(voice, dirs());
    if (!model) throw new Error(mt('tts.errorNoVoice'));
    return { voice, model };
  };

  ipcMain.handle(IPC.ttsPreview, async (_event, request: TtsRequest): Promise<string> => {
    const { voice, model } = await prepare(request);
    const jobId = `preview-${randomUUID()}`;
    const out = join(app.getPath('temp'), `scf-tts-preview-${randomUUID()}.wav`);
    try {
      // A short line, so the preview is quick whatever the box holds - cut between words, its pauses kept.
      const text = previewScript(typeof request.text === 'string' ? request.text : '', 200) || mt('tts.previewFallback');
      const outcome = await synth.synth(jobId, { text, engine: voice.engine, phonemes: voice.phonemes, model, speakerId: voice.speakerId, speed: request.speed, sentenceSilence: 0.2 }, out);
      if (!outcome.path) throw new Error(mt('tts.errorEngine', { detail: 'cancelled' }));
      // Heard as it will be: the same pitch and the same clear voice as the clip.
      const finished = `${out}.ready.wav`;
      await finishVoice(resolveFfmpegPath(), outcome.path, finished, { pitch: request.pitch ?? 0, enhance: request.enhance !== false, sampleRate: voice.sampleRate, effect: effectOf(request.effect) });
      const bytes = await readFile(finished);
      await rm(finished, { force: true }).catch(() => undefined);
      return `data:audio/wav;base64,${bytes.toString('base64')}`;
    } catch (error) {
      if (error instanceof SynthError) throw new Error(mt('tts.errorEngine', { detail: error.detail }));
      throw error;
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.ttsGenerate, async (_event, jobId: string, request: TtsRequest): Promise<TtsResult> => {
    const { voice, model } = await prepare(request);
    const text = typeof request.text === 'string' ? request.text : '';
    // Piper's raw output goes to temp; the finished clip is kept with the
    // app's data - a project reads it for as long as it lives, and Windows
    // empties temp when it likes - allow-listed like any other source.
    const raw = join(app.getPath('temp'), `scf-tts-${randomUUID()}.wav`);
    const folder = join(app.getPath('userData'), 'scf', 'voices');
    try {
      const outcome = await synth.synth(
        jobId,
        { text, engine: voice.engine, phonemes: voice.phonemes, model, speakerId: voice.speakerId, speed: request.speed, sentenceSilence: 0.35 },
        raw,
        (fraction) => send(IPC.ttsProgress, { jobId, fraction: fraction * 0.9 } satisfies TtsProgressEvent),
      );
      if (!outcome.path) return { cancelled: outcome.cancelled, path: null, durationSeconds: 0, segments: [] };
      await mkdir(folder, { recursive: true });
      const kept = join(folder, `voice-${randomUUID()}.wav`);
      await finishVoice(resolveFfmpegPath(), outcome.path, kept, { pitch: request.pitch ?? 0, enhance: request.enhance !== false, sampleRate: voice.sampleRate, effect: effectOf(request.effect) });
      send(IPC.ttsProgress, { jobId, fraction: 1 } satisfies TtsProgressEvent);
      allowPath(kept);
      // The length of what is kept: the silence at its ends is gone, so captions of it end with its last word.
      const finished = await readWav(kept).catch(() => null);
      const durationSeconds = finished ? finished.samples.length / finished.sampleRate : outcome.durationSeconds;
      return { cancelled: false, path: kept, durationSeconds, segments: outcome.segments };
    } catch (error) {
      if (error instanceof SynthError) throw new Error(mt('tts.errorEngine', { detail: error.detail }));
      throw error;
    } finally {
      await rm(raw, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.ttsCancel, (_event, jobId: string) => synth.cancel(jobId));

  return synth;
}
