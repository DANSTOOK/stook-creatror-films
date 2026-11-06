import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  IPC,
  type AzureSpeechStatus,
  type TtsEngineStatus,
  type TtsProgressEvent,
  type TtsRequest,
  type TtsResult,
  type TtsVoiceId,
  type TtsVoiceProgress,
  type TtsVoiceStatus,
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
import { forgetAccount, keychainAvailable, readAccount, writeAccount } from './azure/account';
import {
  AzureError,
  checkAccount,
  looksLikeKey,
  looksLikeRegion,
  OUTPUT_SAMPLE_RATE as AZURE_SAMPLE_RATE,
  type AzureFetch,
  type AzureVoice,
} from './azure/client';
import { offeredVoices, type AzureVoiceChoice } from './azure/voices';
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

/* Azure ---------------------------------------------------------------------- */

/**
 * Azure's side, held for this session.
 *
 * The voices list is asked for once - when a key is saved, when the app
 * starts with one already stored, or when the person presses Check - and
 * kept, because it changes about as often as Microsoft releases voices and
 * a request before every synthesis would be a second thing to fail.
 *
 * `problem` is why the last attempt did not work, as the last part of an
 * i18n key. It is what the panel says instead of leaving a person to guess
 * whether it was the key, the region or the connection.
 */
const azure: { voices: AzureVoiceChoice[]; problem?: AzureProblem; asked: boolean } = { voices: [], asked: false };

/** Electron's own fetch, so the system proxy is used and the renderer is never involved. */
const azureFetch = (): AzureFetch => (url, init) => net.fetch(url, init as RequestInit) as ReturnType<AzureFetch>;

/** The last part of a `tts.azure.error.*` key: a union, so the key itself stays a known one. */
type AzureProblem = 'badKey' | 'badRegion' | 'rateLimit' | 'offline' | 'service' | 'rejected' | 'noVoices' | 'unknown';

/** Which i18n key's last part describes a failure. */
function problemOf(error: unknown): AzureProblem {
  if (!(error instanceof AzureError)) return 'unknown';
  switch (error.failure.kind) {
    case 'badKey': return 'badKey';
    case 'badRegion': return 'badRegion';
    case 'rateLimit': return 'rateLimit';
    case 'offline': return 'offline';
    case 'service': return 'service';
    case 'rejected': return 'rejected';
  }
}

/**
 * Ask Azure what this key can speak.
 *
 * A failure is recorded, not thrown: the panel needs a status to show
 * either way, and the one thing worse than no voices is no explanation.
 */
async function refreshAzure(): Promise<void> {
  azure.asked = true;
  const account = readAccount();
  if (!account) {
    azure.voices = [];
    azure.problem = undefined;
    return;
  }
  try {
    const live: AzureVoice[] = await checkAccount(account, { fetch: azureFetch() });
    azure.voices = offeredVoices(live);
    // A key that works but speaks none of the shortlist is a real answer, and
    // a different one from a key that was refused.
    azure.problem = azure.voices.length === 0 ? 'noVoices' : undefined;
  } catch (error) {
    azure.voices = [];
    azure.problem = problemOf(error);
  }
}

const azureStatus = (): AzureSpeechStatus => {
  const account = readAccount();
  return {
    configured: account !== null,
    region: account?.region ?? '',
    keychain: keychainAvailable(),
    voiceCount: azure.voices.length,
    problem: azure.problem,
  };
};

/** Azure's voices as the picker's own kind of entry. */
const azureVoiceStatuses = (): TtsVoiceStatus[] =>
  azure.voices.map((voice) => ({
    id: voice.shortName,
    engine: 'azure' as const,
    name: voice.name,
    // Every Azure voice shares one description: they are all the same kind of
    // thing, and inventing a persona for each would be writing fiction about
    // voices this app did not train.
    persona: 'azure',
    language: voice.locale.startsWith('es') ? ('es' as const) : ('en' as const),
    region: voice.locale,
    sex: voice.sex,
    licence: 'Microsoft Azure AI Speech (your own resource)',
    bundled: false,
    present: true,
    downloadBytes: 0,
    styles: voice.styles,
  }));

/** The voice the page asked for, when it is one of Azure's. */
const azureVoiceFor = (id: unknown): AzureVoiceChoice | undefined => azure.voices.find((voice) => voice.shortName === id);

export function registerTtsHandlers(getWindow: () => BrowserWindow | null): Synthesizer {
  const synth = new Synthesizer({ tempRoot: join(app.getPath('temp'), 'scf-tts'), engine: currentEngine, kokoro: currentKokoro, azureFetch });
  void synth.sweep();
  // A key stored on this computer is checked once at startup, so the panel
  // opens with the voices already there instead of an empty picker.
  if (readAccount()) void refreshAzure();

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const status = async (): Promise<TtsEngineStatus> => {
    const places = dirs();
    // Azure needs nothing installed, so a key that works is a working engine
    // even on a build with no local one.
    const available = currentEngine() !== null || currentKokoro() !== null || azure.voices.length > 0;
    return {
      available,
      supportsPitch: true,
      disclosureRequired: false,
      voiceSource: VOICE_SOURCE,
      azure: azureStatus(),
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
      ).then((local) => [...azureVoiceStatuses(), ...local]),
    };
  };

  ipcMain.handle(IPC.ttsStatus, async () => {
    // The first call from a page that has just opened also settles whether a
    // stored key works, so the panel never shows "no voices" before asking.
    if (!azure.asked && readAccount()) await refreshAzure();
    return status();
  });

  /* The Azure account ---------------------------------------------------------- */

  ipcMain.handle(IPC.ttsAzureSave, async (_event, key: unknown, region: unknown): Promise<TtsEngineStatus> => {
    const trimmedKey = typeof key === 'string' ? key.trim() : '';
    const trimmedRegion = typeof region === 'string' ? region.trim() : '';
    if (!looksLikeKey(trimmedKey)) throw new Error(mt('tts.azure.errorKeyShape'));
    if (!/^https:\/\//i.test(trimmedRegion) && !looksLikeRegion(trimmedRegion)) throw new Error(mt('tts.azure.errorRegionShape'));
    writeAccount({ key: trimmedKey, region: trimmedRegion });
    await refreshAzure();
    // A key that was refused is not kept: leaving it would mean the panel
    // says "configured" about something that cannot speak.
    if (azure.problem === 'badKey' || azure.problem === 'badRegion') {
      forgetAccount();
      const problem = azure.problem;
      azure.problem = problem;
      throw new Error(mt(`tts.azure.error.${problem}`));
    }
    return status();
  });

  ipcMain.handle(IPC.ttsAzureForget, async (): Promise<TtsEngineStatus> => {
    forgetAccount();
    azure.voices = [];
    azure.problem = undefined;
    return status();
  });

  ipcMain.handle(IPC.ttsAzureCheck, async (): Promise<TtsEngineStatus> => {
    await refreshAzure();
    return status();
  });

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

  /**
   * What one request needs: which engine, and what to hand `synth` and
   * `finishVoice`.
   *
   * The two engines differ in one thing besides where they run. Azure changes
   * the pitch inside the model, which keeps the voice sounding like itself;
   * shifting its finished audio as well would apply the same change twice, so
   * for Azure the pitch goes into the SSML and `finishVoice` is given zero.
   * Everything else it does - "clear voice", the characters - still applies.
   */
  interface Plan {
    /** Passed to `synth`. */
    request: Omit<Parameters<Synthesizer['synth']>[1], 'text' | 'sentenceSilence'>;
    /** Passed to `finishVoice`. */
    sampleRate: number;
    pitch: number;
  }

  const prepare = async (request: TtsRequest): Promise<Plan> => {
    const chosen = azureVoiceFor(request?.voice);
    if (chosen) {
      const account = readAccount();
      if (!account) throw new Error(mt('tts.azure.errorNoKey'));
      // A style the voice does not actually have is dropped rather than sent:
      // Azure would silently ignore it, which looks like the app lying.
      const style = typeof request.style === 'string' && chosen.styles.includes(request.style) ? request.style : undefined;
      return {
        request: {
          engine: 'azure',
          azure: { account, voice: chosen.shortName, style, semitones: request.pitch ?? 0 },
          model: '',
          speakerId: 0,
          speed: request.speed,
        },
        sampleRate: AZURE_SAMPLE_RATE,
        pitch: 0,
      };
    }
    const voice = voiceById(request?.voice) ?? BUNDLED_VOICES.find(engineFor) ?? BUNDLED_VOICES[0];
    if (!engineFor(voice) || !(await isVoiceReady(voice, dirs()))) throw new Error(mt('tts.errorNoVoice'));
    const model = voiceModelPath(voice, dirs());
    if (!model) throw new Error(mt('tts.errorNoVoice'));
    return {
      request: { engine: voice.engine, phonemes: voice.phonemes, model, speakerId: voice.speakerId, speed: request.speed },
      sampleRate: voice.sampleRate,
      pitch: request.pitch ?? 0,
    };
  };

  ipcMain.handle(IPC.ttsPreview, async (_event, request: TtsRequest): Promise<string> => {
    const plan = await prepare(request);
    const jobId = `preview-${randomUUID()}`;
    const out = join(app.getPath('temp'), `scf-tts-preview-${randomUUID()}.wav`);
    try {
      // A short line, so the preview is quick whatever the box holds - cut between words, its pauses kept.
      const text = previewScript(typeof request.text === 'string' ? request.text : '', 200) || mt('tts.previewFallback');
      const outcome = await synth.synth(jobId, { ...plan.request, text, sentenceSilence: 0.2 }, out);
      if (!outcome.path) throw new Error(mt('tts.errorEngine', { detail: 'cancelled' }));
      // Heard as it will be: the same pitch and the same clear voice as the clip.
      const finished = `${out}.ready.wav`;
      await finishVoice(resolveFfmpegPath(), outcome.path, finished, { pitch: plan.pitch, enhance: request.enhance !== false, sampleRate: plan.sampleRate, effect: effectOf(request.effect) });
      const bytes = await readFile(finished);
      await rm(finished, { force: true }).catch(() => undefined);
      return `data:audio/wav;base64,${bytes.toString('base64')}`;
    } catch (error) {
      // Azure's own refusals say which one it was, so the panel can tell a
      // refused key apart from a lost connection.
      if (error instanceof AzureError) throw new Error(mt(`tts.azure.error.${problemOf(error)}`));
      if (error instanceof SynthError) throw new Error(mt('tts.errorEngine', { detail: error.detail }));
      throw error;
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.ttsGenerate, async (_event, jobId: string, request: TtsRequest): Promise<TtsResult> => {
    const plan = await prepare(request);
    const text = typeof request.text === 'string' ? request.text : '';
    // Piper's raw output goes to temp; the finished clip is kept with the
    // app's data - a project reads it for as long as it lives, and Windows
    // empties temp when it likes - allow-listed like any other source.
    const raw = join(app.getPath('temp'), `scf-tts-${randomUUID()}.wav`);
    const folder = join(app.getPath('userData'), 'scf', 'voices');
    try {
      const outcome = await synth.synth(
        jobId,
        { ...plan.request, text, sentenceSilence: 0.35 },
        raw,
        (fraction) => send(IPC.ttsProgress, { jobId, fraction: fraction * 0.9 } satisfies TtsProgressEvent),
      );
      if (!outcome.path) return { cancelled: outcome.cancelled, path: null, durationSeconds: 0, segments: [] };
      await mkdir(folder, { recursive: true });
      const kept = join(folder, `voice-${randomUUID()}.wav`);
      await finishVoice(resolveFfmpegPath(), outcome.path, kept, { pitch: plan.pitch, enhance: request.enhance !== false, sampleRate: plan.sampleRate, effect: effectOf(request.effect) });
      send(IPC.ttsProgress, { jobId, fraction: 1 } satisfies TtsProgressEvent);
      allowPath(kept);
      // The length of what is kept: the silence at its ends is gone, so captions of it end with its last word.
      const finished = await readWav(kept).catch(() => null);
      const durationSeconds = finished ? finished.samples.length / finished.sampleRate : outcome.durationSeconds;
      return { cancelled: false, path: kept, durationSeconds, segments: outcome.segments };
    } catch (error) {
      // Azure's own refusals say which one it was, so the panel can tell a
      // refused key apart from a lost connection.
      if (error instanceof AzureError) throw new Error(mt(`tts.azure.error.${problemOf(error)}`));
      if (error instanceof SynthError) throw new Error(mt('tts.errorEngine', { detail: error.detail }));
      throw error;
    } finally {
      await rm(raw, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.ttsCancel, (_event, jobId: string) => synth.cancel(jobId));

  return synth;
}
