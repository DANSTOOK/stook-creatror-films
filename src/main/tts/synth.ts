import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, freemem } from 'node:os';
import { parseScript } from '@shared/tts/script';
import { kokoroCommand, piperCommand, splitText, windowsCodePage, type PiperEngine } from './engine';
import type { TtsEngineKind } from './catalog';
import { readWav, silence, trimSilence, writeWav } from './wav';

/**
 * Text-to-speech jobs: words in, one WAV out, nothing left behind.
 *
 * The script is read for the pauses written into it (shared/tts/script), and
 * its speech split into sentence-sized pieces (engine.splitText). The engine
 * is run once per piece, each writing a small WAV into a folder of the job's
 * own under the system temp directory - a few pieces at a time on a computer
 * with the cores for it, so a long text takes a fraction of the time. Each
 * piece's own silence at its ends is cut, and the pieces are joined with a
 * short gap between them, or with exactly the pause written there, into the
 * single clip the page imports; where each piece landed comes back with it,
 * for captions that follow the voice. The engines are child processes, as
 * ffmpeg and whisper-cli are: a cancel kills them, and whether the job ends,
 * fails or is cancelled its folder is deleted. Nothing here opens a network
 * connection.
 */

export class SynthError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SynthError';
  }
}

export interface SynthRequest {
  text: string;
  /** Which program speaks: Piper, or Kokoro through sherpa-onnx. */
  engine?: TtsEngineKind;
  /** Piper: the voice's .onnx (its .onnx.json beside it). Kokoro: the model's folder. */
  model: string;
  /** Kokoro: espeak-ng's voice for the text (es-419). */
  phonemes?: string;
  speakerId: number;
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

const tail = (text: string, lines = 4): string =>
  text.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join(' / ').slice(-500);

/**
 * A job's folder untouched this long is a crashed session's leftovers. A job
 * that is running writes a piece into its folder every few seconds - a piece
 * is at most a few hundred characters - so an hour is far beyond any of them.
 */
export const STALE_JOB_MS = 60 * 60 * 1000;

const MB = 1024 * 1024;

/**
 * How many pieces run at once, and with how many threads each. One engine
 * process makes poor use of a big CPU: measured on a 24-core laptop, Kokoro
 * spoke 108 s of voice in 71 s as one process of 8 threads, in 39 s as four
 * of 5 and in 24 s as six of 2 - its threads share the work badly, separate
 * processes well. So a long text is spoken by up to six processes side by
 * side, two threads each, half the cores left to the editor. Each holds the
 * model (about 420 MB, measured), so free memory caps them too, 2 GB kept
 * spare. A small machine stays at one.
 */
export function workerPlan(cores: number, freeBytes = Number.POSITIVE_INFINITY): { workers: number; threads: number } {
  const byMemory = Math.floor((freeBytes - 2048 * MB) / (450 * MB));
  const workers = Math.max(1, Math.min(6, Math.floor(cores / 4), byMemory));
  return { workers, threads: Math.max(1, Math.min(4, Math.floor(cores / (workers * 2)))) };
}

/** What a job runs: a piece of speech for the engine, or a pause written into the script. */
export type Step = { kind: 'speech'; text: string } | { kind: 'pause'; seconds: number };

/** The script as steps: each stretch of speech in engine-sized pieces, the pauses between them. */
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
  children: Set<ChildProcess>;
  cancelled: boolean;
}

export class Synthesizer {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly options: {
      tempRoot: string;
      engine: () => PiperEngine | null;
      /** Kokoro's program, and the espeak-ng data it reads (Piper's own). */
      kokoro?: () => { engine: PiperEngine; espeakData: string } | null;
      /** Cores and free memory to plan for; the machine's by default (a test sets them). */
      cores?: number;
      freeBytes?: number;
    },
  ) {}

  /**
   * Whatever a crashed session left behind under the temp root - and only
   * that. The root is shared by every copy of the app on this account (a
   * second window, a test run), so a job folder another copy is still filling
   * is left alone: emptying the whole root, as this did, deleted a long text's
   * folder halfway through and its next piece could not be written ("Failed
   * to create ...\9.wav").
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
    for (const child of job.children) child.kill();
  }

  /**
   * Synthesise `request.text` to one WAV at `outPath`. `onProgress` is called
   * with the fraction of pieces finished so the page can show a bar and the
   * work does not block anything (the engines run off in their own processes).
   */
  async synth(jobId: string, request: SynthRequest, outPath: string, onProgress?: (fraction: number) => void): Promise<SynthOutcome> {
    const kokoro = request.engine === 'kokoro' ? (this.options.kokoro?.() ?? null) : null;
    const engine = request.engine === 'kokoro' ? (kokoro?.engine ?? null) : this.options.engine();
    if (!engine) throw new SynthError('The text-to-speech engine is not part of this build');
    const steps = scriptSteps(request.text);
    const speech = steps.flatMap((step, index) => (step.kind === 'speech' ? [{ index, text: step.text }] : []));
    if (speech.length === 0) throw new SynthError('There is no text to speak');

    const dir = join(this.options.tempRoot, jobId);
    const job: Job = { dir, children: new Set(), cancelled: false };
    this.jobs.set(jobId, job);
    await mkdir(dir, { recursive: true });
    const cancelled: SynthOutcome = { cancelled: true, path: null, durationSeconds: 0, segments: [] };

    try {
      const plan = workerPlan(this.options.cores ?? cpus().length, this.options.freeBytes ?? freemem());
      const workers = Math.min(plan.workers, speech.length);
      const made = new Map<number, { sampleRate: number; samples: Int16Array }>();
      let next = 0;
      let done = 0;
      // Each worker takes the next piece in order until none is left; the pieces are joined in order afterwards.
      const work = async (): Promise<void> => {
        while (!job.cancelled && next < speech.length) {
          const piece = speech[next];
          next += 1;
          const pieceWav = join(dir, `${piece.index}.wav`);
          const run = (): Promise<void> =>
            kokoro
              ? this.runKokoroPiece(job, kokoro.engine, kokoro.espeakData, request, piece.text, pieceWav, plan.threads)
              : this.runPiece(job, engine, request, piece.text, pieceWav);
          // The folder is made again before each piece, and a piece that fails
          // is tried once more: whatever empties temp meanwhile (a cleaner,
          // Storage Sense) costs a moment, not the text. The pieces made so far
          // are held here, not on disk.
          await mkdir(dir, { recursive: true });
          try {
            await run();
          } catch {
            if (job.cancelled) return;
            await mkdir(dir, { recursive: true });
            await run();
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
        for (const child of job.children) child.kill();
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

  /** Runs one engine process for `job`; resolves when it ends well (or is cancelled), rejects with its last words. */
  private spawnPiece(job: Job, bin: string, args: string[], dir: string, input: string | null, name: string, options: { windowsHide?: boolean } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd: dir, ...options });
      job.children.add(child);
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
      });
      child.stdout?.resume();
      child.on('error', (error) => {
        job.children.delete(child);
        reject(new SynthError(String(error)));
      });
      child.on('close', (code) => {
        job.children.delete(child);
        if (job.cancelled || code === 0) return resolve();
        reject(new SynthError(tail(stderr) || `${name} exited with ${code}`));
      });
      if (input !== null) child.stdin?.end(input);
    });
  }

  /** One piece through Kokoro: the text is the program's last argument (engine.kokoroCommand). */
  private runKokoroPiece(job: Job, engine: PiperEngine, espeakData: string, request: SynthRequest, text: string, output: string, threads: number): Promise<void> {
    const args = kokoroCommand({
      modelDir: request.model,
      espeakData,
      speakerId: request.speakerId,
      phonemes: request.phonemes ?? 'es-419',
      output,
      speed: request.speed,
      threads,
      codePage: windowsCodePage(),
      text,
    });
    return this.spawnPiece(job, engine.bin, args, engine.dir, null, 'sherpa-onnx', { windowsHide: true });
  }

  private runPiece(job: Job, engine: PiperEngine, request: SynthRequest, text: string, output: string): Promise<void> {
    const args = piperCommand({
      model: request.model,
      speakerId: request.speakerId,
      output,
      speed: request.speed,
      sentenceSilence: request.sentenceSilence,
    });
    // The engine's own folder as the working directory so it loads its DLLs
    // and finds its espeak-ng data beside the executable. The text is fed on
    // stdin, never as an argument: any length, any characters, nothing
    // interpreted.
    return this.spawnPiece(job, engine.bin, args, engine.dir, `${text.replace(/[\r\n]+/g, ' ')}\n`, 'piper');
  }
}
