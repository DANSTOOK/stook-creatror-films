import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseScript } from '@shared/tts/script';
import { splitText } from './split';
import { AzureError, synthesize, type AzureAccount, type AzureFetch } from './azure/client';
import { readWav, silence, trimSilence, writeWav } from './wav';

/**
 * Text-to-speech jobs: words in, one WAV out, nothing left behind.
 *
 * The script is read for the pauses written into it (shared/tts/script), and
 * its speech split into pieces one request can speak (split.splitText). Each
 * piece is asked of Azure AI Speech and written as a small WAV into a folder
 * of the job's own under the system temp directory - a few at a time, so a
 * long text takes a fraction of the time. Each piece's own silence at its
 * ends is cut, and the pieces are joined with a short gap between them, or
 * with exactly the pause written there, into the single clip the page
 * imports; where each piece landed comes back with it, for captions that
 * follow the voice.
 *
 * The pauses, the trimming, the joining and the caption timings are measured
 * from the audio that came back, never reported by whoever made it - which is
 * why they are still done here and not handed to the service as SSML
 * `<break>`s. A cancel aborts the requests in flight, and whether the job
 * ends, fails or is cancelled its folder is deleted.
 *
 * There was a time when this ran two programs on this computer (Piper, and
 * Kokoro through sherpa-onnx) as child processes beside ffmpeg and
 * whisper-cli. They are gone, and with them the plan that counted cores and
 * memory: nothing on this computer is the bottleneck for a request.
 */

export class SynthError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SynthError';
  }
}

/** Which voice speaks, on whose account, and how. */
export interface AzureSynth {
  account: AzureAccount;
  /** Azure's `ShortName`, e.g. `es-MX-DaliaNeural`. */
  voice: string;
  /** An `<mstts:express-as>` style the voice actually has, or none. */
  style?: string;
  styleDegree?: number;
  role?: string;
  /**
   * Semitones up or down. Azure changes the pitch in the model, which is
   * better than shifting the finished audio - so the panel's pitch comes
   * here and `finishVoice` is told to leave it alone.
   */
  semitones?: number;
}

export interface SynthRequest {
  text: string;
  /** The voice and the account that speaks it. */
  azure: AzureSynth;
  /** 0.5-2, where 1 is the voice's natural pace. */
  speed: number;
  /** Silence between joined pieces, seconds. A pause written into the script replaces it there. */
  sentenceSilence: number;
}

/** Where one piece of speech is in the finished WAV, seconds, and what it says. */
export interface SpokenSegment {
  start: number;
  end: number;
  text: string;
}

export interface SynthOutcome {
  cancelled: boolean;
  /** The finished WAV, or null when cancelled before anything was made. */
  path: string | null;
  durationSeconds: number;
  /** Each piece of speech, in order: captions are timed by these. */
  segments: SpokenSegment[];
}

/**
 * A job's folder untouched this long is a crashed session's leftovers. A job
 * that is running writes a piece into its folder every few seconds - a piece
 * is at most a few hundred characters - so an hour is far beyond any of them.
 */
export const STALE_JOB_MS = 60 * 60 * 1000;

/** What a job runs: a piece of speech to be said, or a pause written into the script. */
export type Step = { kind: 'speech'; text: string } | { kind: 'pause'; seconds: number };

/** The script as steps: each stretch of speech in request-sized pieces, the pauses between them. */
export function scriptSteps(text: string): Step[] {
  return parseScript(text).flatMap((part): Step[] =>
    part.kind === 'pause' ? [part] : splitText(part.text).map((piece) => ({ kind: 'speech' as const, text: piece })),
  );
}

/**
 * The pieces joined in script order: between two pieces of speech, `gap`
 * seconds of silence; at a pause, exactly that pause and nothing more (no gap
 * beside it). Where each piece lands is kept for the captions.
 */
export function joinSteps(steps: readonly Step[], made: ReadonlyMap<number, Int16Array>, sampleRate: number, gap: number): { parts: Int16Array[]; segments: SpokenSegment[] } {
  const parts: Int16Array[] = [];
  const segments: SpokenSegment[] = [];
  let at = 0;
  let previous: Step['kind'] | null = null;
  steps.forEach((step, index) => {
    if (step.kind === 'pause') {
      const pause = silence(step.seconds, sampleRate);
      parts.push(pause);
      at += pause.length / sampleRate;
    } else {
      const samples = made.get(index) ?? new Int16Array(0);
      if (previous === 'speech' && gap > 0) {
        const between = silence(gap, sampleRate);
        parts.push(between);
        at += between.length / sampleRate;
      }
      const seconds = samples.length / sampleRate;
      segments.push({ start: at, end: at + seconds, text: step.text });
      parts.push(samples);
      at += seconds;
    }
    previous = step.kind;
  });
  return { parts, segments };
}

interface Job {
  dir: string;
  /** The requests in flight; a cancel aborts these. */
  aborts: Set<AbortController>;
  cancelled: boolean;
}

/**
 * How many requests run at once.
 *
 * Nothing on this computer is the bottleneck, so there is no plan to make
 * from cores and memory. Three is chosen to be well inside the rate a
 * resource allows while still being three times quicker than one at a time;
 * a 429 is waited out by the client rather than avoided by going slower.
 */
export const AZURE_WORKERS = 3;

export class Synthesizer {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly options: {
      tempRoot: string;
      /** How Azure is called: Electron's `net.fetch` in the app, a stand-in in the tests. */
      azureFetch: () => AzureFetch;
    },
  ) {}

  /**
   * Whatever a crashed session left behind under the temp root - and only
   * that. The root is shared by every copy of the app on this account (a
   * second window, a test run), so a job folder another copy is still filling
   * is left alone: emptying the whole root, as this did, deleted a long text's
   * folder halfway through and its next piece could not be written.
   */
  async sweep(now = Date.now()): Promise<void> {
    const entries = await readdir(this.options.tempRoot).catch(() => [] as string[]);
    await Promise.all(
      entries.map(async (name) => {
        const path = join(this.options.tempRoot, name);
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs > STALE_JOB_MS) await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    for (const abort of job.aborts) abort.abort();
  }

  /**
   * Synthesise `request.text` to one WAV at `outPath`. `onProgress` is called
   * with the fraction of pieces finished so the page can show a bar.
   */
  async synth(jobId: string, request: SynthRequest, outPath: string, onProgress?: (fraction: number) => void): Promise<SynthOutcome> {
    const azure = request.azure;
    if (!azure) throw new SynthError('No Azure account for this voice');
    const steps = scriptSteps(request.text);
    const speech = steps.flatMap((step, index) => (step.kind === 'speech' ? [{ index, text: step.text }] : []));
    if (speech.length === 0) throw new SynthError('There is no text to speak');

    const dir = join(this.options.tempRoot, jobId);
    const job: Job = { dir, aborts: new Set(), cancelled: false };
    this.jobs.set(jobId, job);
    await mkdir(dir, { recursive: true });
    const cancelled: SynthOutcome = { cancelled: true, path: null, durationSeconds: 0, segments: [] };

    try {
      const workers = Math.min(AZURE_WORKERS, speech.length);
      const made = new Map<number, { sampleRate: number; samples: Int16Array }>();
      let next = 0;
      let done = 0;
      // Each worker takes the next piece in order until none is left; the pieces are joined in order afterwards.
      const work = async (): Promise<void> => {
        while (!job.cancelled && next < speech.length) {
          const piece = speech[next];
          next += 1;
          const pieceWav = join(dir, `${piece.index}.wav`);
          // The folder is made again before each piece, and a piece that fails
          // is tried once more: whatever empties temp meanwhile (a cleaner,
          // Storage Sense) costs a moment, not the text. The pieces made so far
          // are held here, not on disk.
          await mkdir(dir, { recursive: true });
          try {
            await this.runPiece(job, azure, request, piece.text, pieceWav);
          } catch (error) {
            if (job.cancelled) return;
            // A key Azure refused, or SSML it would not parse, fails the same
            // way the second time: retrying only delays the message. The
            // client has already waited out whatever was worth waiting for.
            if (error instanceof AzureError) throw error;
            await mkdir(dir, { recursive: true });
            await this.runPiece(job, azure, request, piece.text, pieceWav);
          }
          if (job.cancelled) return;
          const wav = await readWav(pieceWav);
          made.set(piece.index, { sampleRate: wav.sampleRate, samples: trimSilence(wav.samples, wav.sampleRate) });
          done += 1;
          onProgress?.(done / speech.length);
        }
      };
      const running = Array.from({ length: workers }, () => work());
      try {
        await Promise.all(running);
      } catch (error) {
        // One piece failed for good: the others are stopped rather than left to run on.
        job.cancelled = true;
        for (const abort of job.aborts) abort.abort();
        await Promise.allSettled(running);
        throw error;
      }
      if (job.cancelled) return cancelled;

      const sampleRate = made.get(speech[0].index)?.sampleRate ?? 24000;
      const samples = new Map([...made].map(([index, piece]) => [index, piece.samples]));
      const { parts, segments } = joinSteps(steps, samples, sampleRate, request.sentenceSilence);
      const durationSeconds = await writeWav(outPath, sampleRate, parts);
      return { cancelled: false, path: outPath, durationSeconds, segments };
    } finally {
      this.jobs.delete(jobId);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * One piece: a request, and what comes back written as a WAV.
   *
   * Everything after this - trimming, the pauses, the joining, the caption
   * timings - works on that file. The error is left as an `AzureError`
   * rather than wrapped in a `SynthError`, because the panel turns its
   * `failure` into the one sentence that says what to do about it; the
   * handler in ttsIpc does the wrapping.
   */
  private async runPiece(job: Job, azure: AzureSynth, request: SynthRequest, text: string, output: string): Promise<void> {
    const fetch = this.options.azureFetch();
    if (!fetch) throw new SynthError('No way to reach Azure in this build');
    const abort = new AbortController();
    job.aborts.add(abort);
    try {
      const audio = await synthesize(
        azure.account,
        {
          voice: azure.voice,
          text,
          rate: request.speed,
          semitones: azure.semitones,
          style: azure.style,
          styleDegree: azure.styleDegree,
          role: azure.role,
        },
        { fetch, signal: abort.signal },
      );
      if (job.cancelled) return;
      await writeFile(output, audio);
    } finally {
      job.aborts.delete(abort);
    }
  }
}
