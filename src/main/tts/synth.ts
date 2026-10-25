import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { kokoroCommand, piperCommand, splitText, windowsCodePage, type PiperEngine } from './engine';
import type { TtsEngineKind } from './catalog';
import { readWav, silence, writeWav } from './wav';

/**
 * Text-to-speech jobs: words in, one WAV out, nothing left behind.
 *
 * Long text is split into sentence-sized pieces (engine.splitText) and Piper
 * is run once per piece, each writing a small WAV into a folder of the job's
 * own under the system temp directory. The pieces are joined with a short
 * silence between them into the single clip the page imports. Piper is a child
 * process, as ffmpeg and whisper-cli are: a cancel kills it, and whether the
 * job ends, fails or is cancelled its folder is deleted. Nothing here opens a
 * network connection.
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
  /** Silence between joined pieces, seconds. */
  sentenceSilence: number;
}

export interface SynthOutcome {
  cancelled: boolean;
  /** The finished WAV, or null when cancelled before anything was made. */
  path: string | null;
  durationSeconds: number;
}

const tail = (text: string, lines = 4): string =>
  text.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join(' / ').slice(-500);

/**
 * A job's folder untouched this long is a crashed session's leftovers. A job
 * that is running writes a piece into its folder every few seconds - a piece
 * is at most a few hundred characters - so an hour is far beyond any of them.
 */
export const STALE_JOB_MS = 60 * 60 * 1000;

interface Job {
  dir: string;
  child: ChildProcess | null;
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
    job.child?.kill();
  }

  /**
   * Synthesise `request.text` to one WAV at `outPath`. `onProgress` is called
   * with the fraction of pieces finished so the page can show a bar and the
   * work does not block anything (Piper runs off in its own process).
   */
  async synth(jobId: string, request: SynthRequest, outPath: string, onProgress?: (fraction: number) => void): Promise<SynthOutcome> {
    const kokoro = request.engine === 'kokoro' ? (this.options.kokoro?.() ?? null) : null;
    const engine = request.engine === 'kokoro' ? (kokoro?.engine ?? null) : this.options.engine();
    if (!engine) throw new SynthError('The text-to-speech engine is not part of this build');
    const pieces = splitText(request.text);
    if (pieces.length === 0) throw new SynthError('There is no text to speak');

    const dir = join(this.options.tempRoot, jobId);
    const job: Job = { dir, child: null, cancelled: false };
    this.jobs.set(jobId, job);
    await mkdir(dir, { recursive: true });

    try {
      const parts: Int16Array[] = [];
      let sampleRate = 0;
      for (let index = 0; index < pieces.length; index += 1) {
        if (job.cancelled) return { cancelled: true, path: null, durationSeconds: 0 };
        const pieceWav = join(dir, `${index}.wav`);
        const run = (): Promise<void> =>
          kokoro
            ? this.runKokoroPiece(job, kokoro.engine, kokoro.espeakData, request, pieces[index], pieceWav)
            : this.runPiece(job, engine, request, pieces[index], pieceWav);
        // The folder is made again before each piece, and a piece that fails
        // is tried once more: whatever empties temp meanwhile (a cleaner,
        // Storage Sense) costs a moment, not the text. The pieces made so far
        // are held here, not on disk.
        await mkdir(dir, { recursive: true });
        try {
          await run();
        } catch {
          if (job.cancelled) return { cancelled: true, path: null, durationSeconds: 0 };
          await mkdir(dir, { recursive: true });
          await run();
        }
        if (job.cancelled) return { cancelled: true, path: null, durationSeconds: 0 };
        const wav = await readWav(pieceWav);
        sampleRate = wav.sampleRate;
        if (index > 0 && request.sentenceSilence > 0) parts.push(silence(request.sentenceSilence, sampleRate));
        parts.push(wav.samples);
        onProgress?.((index + 1) / pieces.length);
      }
      const durationSeconds = await writeWav(outPath, sampleRate, parts);
      return { cancelled: false, path: outPath, durationSeconds };
    } finally {
      this.jobs.delete(jobId);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** One piece through Kokoro: the text is the program's last argument (engine.kokoroCommand). */
  private runKokoroPiece(job: Job, engine: PiperEngine, espeakData: string, request: SynthRequest, text: string, output: string): Promise<void> {
    const args = kokoroCommand({
      modelDir: request.model,
      espeakData,
      speakerId: request.speakerId,
      phonemes: request.phonemes ?? 'es-419',
      output,
      speed: request.speed,
      // Leave a core to the editor.
      threads: Math.max(1, cpus().length - 1),
      codePage: windowsCodePage(),
      text,
    });
    return new Promise((resolve, reject) => {
      const child = spawn(engine.bin, args, { cwd: engine.dir, windowsHide: true });
      job.child = child;
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
      });
      child.stdout?.resume();
      child.on('error', (error) => reject(new SynthError(String(error))));
      child.on('close', (code) => {
        job.child = null;
        if (job.cancelled || code === 0) return resolve();
        reject(new SynthError(tail(stderr) || `sherpa-onnx exited with ${code}`));
      });
    });
  }

  private runPiece(job: Job, engine: PiperEngine, request: SynthRequest, text: string, output: string): Promise<void> {
    const args = piperCommand({
      model: request.model,
      speakerId: request.speakerId,
      output,
      speed: request.speed,
      sentenceSilence: request.sentenceSilence,
    });
    return new Promise((resolve, reject) => {
      // The engine's own folder on PATH so it loads its DLLs and finds its
      // espeak-ng data beside the executable.
      const child = spawn(engine.bin, args, { cwd: engine.dir });
      job.child = child;
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
      });
      child.on('error', (error) => reject(new SynthError(String(error))));
      child.on('close', (code) => {
        job.child = null;
        if (job.cancelled) return resolve();
        if (code === 0) return resolve();
        reject(new SynthError(tail(stderr) || `piper exited with ${code}`));
      });
      // The text is fed on stdin, never as an argument: any length, any
      // characters, nothing interpreted.
      child.stdin?.end(`${text.replace(/[\r\n]+/g, ' ')}\n`);
    });
  }
}
