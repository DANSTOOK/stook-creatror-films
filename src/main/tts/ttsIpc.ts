import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  IPC,
  type AzureSpeechStatus,
  type TtsEngineStatus,
  type TtsProgressEvent,
  type TtsRequest,
  type TtsResult,
  type TtsVoiceStatus,
} from '@shared/types/ipc';
import { allowPath } from '../ipc/fileSystem';
import { mt } from '../language';
import { previewScript } from '@shared/tts/script';
import { TTS_EFFECTS } from './finish';
import { Synthesizer, SynthError, type SynthRequest } from './synth';
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
 * Text to speech, from the page: the voices, previews and generation jobs.
 *
 * Every voice is Microsoft's, spoken by Azure AI Speech over the network on
 * the person's own key. There is no engine in the installer any more: the two
 * that were there (Piper, and Kokoro through sherpa-onnx) spoke on this
 * computer and have been removed, which is why nothing here looks for a
 * program, a model file or a voice to download. What there is to find out is
 * whether a key is stored and what it can speak, and that is one question
 * asked of the service itself.
 *
 * The key never comes back to the page. The status it gets says whether there
 * is one, which region it is for, and which voices it can speak - never its
 * value.
 *
 * `disclosureRequired` stays false: Azure's terms do not require disclosing
 * machine-generated audio. The field is kept so that an engine whose licence
 * does require it can be surfaced by the panel without further plumbing.
 */

/** A character the page may ask for, or none. */
const effectOf = (value: unknown): TtsRequest['effect'] => (TTS_EFFECTS.includes(value as never) ? (value as TtsRequest['effect']) : 'none');

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
const voiceStatuses = (): TtsVoiceStatus[] =>
  azure.voices.map((voice) => ({
    id: voice.shortName,
    name: voice.name,
    // Every voice shares one description: they are all the same kind of
    // thing, and inventing a persona for each would be writing fiction about
    // voices this app did not train.
    persona: 'azure',
    language: voice.locale.startsWith('es') ? ('es' as const) : ('en' as const),
    region: voice.locale,
    sex: voice.sex,
    licence: 'Microsoft Azure AI Speech (your own resource)',
    styles: voice.styles,
  }));

/** The voice the page asked for, when the key can speak it. */
const voiceFor = (id: unknown): AzureVoiceChoice | undefined => azure.voices.find((voice) => voice.shortName === id);

export function registerTtsHandlers(getWindow: () => BrowserWindow | null): Synthesizer {
  const synth = new Synthesizer({ tempRoot: join(app.getPath('temp'), 'scf-tts'), azureFetch });
  void synth.sweep();
  // A key stored on this computer is checked once at startup, so the panel
  // opens with the voices already there instead of an empty picker.
  if (readAccount()) void refreshAzure();

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const status = (): TtsEngineStatus => ({
    // A key that works is a working engine; nothing needs to be installed.
    available: azure.voices.length > 0,
    supportsPitch: true,
    disclosureRequired: false,
    azure: azureStatus(),
    voices: voiceStatuses(),
  });

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

  /* Preview and generation ------------------------------------------------------ */

  /**
   * What one request needs: the voice, the account, and what to hand `synth`
   * and `finishVoice`.
   *
   * Azure changes the pitch inside the model, which keeps the voice sounding
   * like itself; shifting its finished audio as well would apply the same
   * change twice, so the pitch goes into the SSML and `finishVoice` is given
   * zero. Everything else it does - "clear voice", the characters - still
   * applies.
   */
  const prepare = (request: TtsRequest): Omit<SynthRequest, 'text' | 'sentenceSilence'> => {
    // A voice this key cannot speak - a project made on another computer, or
    // before the key changed - falls back to the first one it can.
    const chosen = voiceFor(request?.voice) ?? azure.voices[0];
    if (!chosen) throw new Error(mt('tts.azure.errorNoKey'));
    const account = readAccount();
    if (!account) throw new Error(mt('tts.azure.errorNoKey'));
    // A style the voice does not actually have is dropped rather than sent:
    // Azure would silently ignore it, which looks like the app lying.
    const style = typeof request.style === 'string' && chosen.styles.includes(request.style) ? request.style : undefined;
    return {
      azure: { account, voice: chosen.shortName, style, semitones: request.pitch ?? 0 },
      speed: request.speed,
    };
  };

  ipcMain.handle(IPC.ttsPreview, async (_event, request: TtsRequest): Promise<string> => {
    const plan = prepare(request);
    const jobId = `preview-${randomUUID()}`;
    const out = join(app.getPath('temp'), `scf-tts-preview-${randomUUID()}.wav`);
    try {
      // A short line, so the preview is quick whatever the box holds - cut between words, its pauses kept.
      const text = previewScript(typeof request.text === 'string' ? request.text : '', 200) || mt('tts.previewFallback');
      const outcome = await synth.synth(jobId, { ...plan, text, sentenceSilence: 0.2 }, out);
      if (!outcome.path) throw new Error(mt('tts.errorEngine', { detail: 'cancelled' }));
      // Heard as it will be: the same pitch and the same clear voice as the clip.
      const finished = `${out}.ready.wav`;
      await finishVoice(resolveFfmpegPath(), outcome.path, finished, { pitch: 0, enhance: request.enhance !== false, sampleRate: AZURE_SAMPLE_RATE, effect: effectOf(request.effect) });
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
    const plan = prepare(request);
    const text = typeof request.text === 'string' ? request.text : '';
    // The raw audio goes to temp; the finished clip is kept with the app's
    // data - a project reads it for as long as it lives, and Windows empties
    // temp when it likes - allow-listed like any other source.
    const raw = join(app.getPath('temp'), `scf-tts-${randomUUID()}.wav`);
    const folder = join(app.getPath('userData'), 'scf', 'voices');
    try {
      const outcome = await synth.synth(
        jobId,
        { ...plan, text, sentenceSilence: 0.35 },
        raw,
        (fraction) => send(IPC.ttsProgress, { jobId, fraction: fraction * 0.9 } satisfies TtsProgressEvent),
      );
      if (!outcome.path) return { cancelled: outcome.cancelled, path: null, durationSeconds: 0, segments: [] };
      await mkdir(folder, { recursive: true });
      const kept = join(folder, `voice-${randomUUID()}.wav`);
      await finishVoice(resolveFfmpegPath(), outcome.path, kept, { pitch: 0, enhance: request.enhance !== false, sampleRate: AZURE_SAMPLE_RATE, effect: effectOf(request.effect) });
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
