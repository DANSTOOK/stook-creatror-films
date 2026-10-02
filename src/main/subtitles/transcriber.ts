import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { cpus, constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';
import type { CaptionWord } from '@shared/types';
import { parseProgress, parseWhisperJson, type WhisperJson } from '@shared/captions/whisperOutput';
import { chooseVulkanDevice, parseVulkanDevices, threadsFor, VULKAN_PROBE_ENV, whisperCommand, type VulkanDevice, type WhisperEngine } from './engine';
import type { CaptionModel } from './catalog';

/**
 * Transcription jobs: sound in, words out, nothing left behind.
 *
 * A job has two steps. First the page sends the timeline's mix (48 kHz
 * stereo float, the mix an export makes) a piece at a time, and the bundled
 * ffmpeg resamples it into the 16 kHz mono WAV Whisper wants, in a folder
 * of the job's own under the system's temporary directory. Then whisper-cli
 * reads that file and writes its JSON beside it.
 *
 * Both are child processes, as the export's ffmpeg is: cancelling kills
 * them, and whether the job ends, fails or is cancelled, its folder is
 * deleted. Neither opens a network connection; the sound never leaves the
 * computer.
 */

/** Sample format the page sends: the export mix's. */
export const MIX_SAMPLE_RATE = 48_000;
export const MIX_CHANNELS = 2;

interface Job {
  id: string;
  dir: string;
  wav: string;
  ffmpeg: ChildProcess | null;
  ffmpegDone: Promise<void> | null;
  whisper: ChildProcess | null;
  cancelled: boolean;
}

export interface TranscriptionOutcome {
  cancelled: boolean;
  words: CaptionWord[];
  dropped: string[];
  ran: 'gpu' | 'cpu';
  gpu: string | null;
  audioSeconds: number;
  elapsedSeconds: number;
}

export class TranscriptionError extends Error {
  constructor(
    readonly kind: 'ffmpeg' | 'whisper' | 'no-job',
    readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'TranscriptionError';
  }
}

const tail = (text: string, lines = 4): string => text.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join(' / ').slice(-500);

/** Run a program to its end and collect what it printed. */
function collect(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
    });
    child.stdout?.on('data', () => undefined);
    child.on('error', (error) => resolve({ code: -1, stderr: `${stderr}\n${String(error)}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

export class Transcriber {
  private readonly jobs = new Map<string, Job>();
  private gpuChoice: Promise<VulkanDevice | 'auto' | null> | null = null;

  constructor(
    private readonly options: {
      /** The folder jobs make their own folders in. */
      tempRoot: string;
      ffmpegPath: () => string;
      engine: () => WhisperEngine | null;
    },
  ) {}

  /** Anything a crashed session left in the temporary folder goes. */
  async sweep(): Promise<void> {
    await rm(this.options.tempRoot, { recursive: true, force: true });
  }

  /**
   * The GPU the program will use, asked of the program itself once: its
   * Vulkan backend lists the GPUs as it loads. See engine.ts.
   */
  chooseGpu(): Promise<VulkanDevice | 'auto' | null> {
    if (this.gpuChoice) return this.gpuChoice;
    const engine = this.options.engine();
    if (!engine || !engine.vulkan) {
      this.gpuChoice = Promise.resolve(null);
      return this.gpuChoice;
    }
    this.gpuChoice = (async () => {
      const child = spawn(engine.cli, ['--help'], { cwd: engine.dir, env: { ...process.env, ...VULKAN_PROBE_ENV }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let printed = '';
      child.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (printed += chunk.toString('utf8')));
      const timer = setTimeout(() => child.kill(), 15_000);
      await new Promise<void>((resolve) => {
        child.on('error', () => resolve());
        child.on('close', () => resolve());
      });
      clearTimeout(timer);
      const devices = parseVulkanDevices(printed);
      // The list could not be read (a driver without Vulkan prints none):
      // let the program choose, which it does dedicated GPUs first.
      if (devices.length === 0) return /ggml_vulkan/i.test(printed) ? null : 'auto';
      return chooseVulkanDevice(devices);
    })();
    return this.gpuChoice;
  }

  /** Start a job: ffmpeg waiting for the mix. Returns the job's id. */
  async openAudio(): Promise<string> {
    const id = randomUUID();
    const dir = join(this.options.tempRoot, id);
    await mkdir(dir, { recursive: true });
    const wav = join(dir, 'audio.wav');
    const ffmpeg = spawn(
      this.options.ffmpegPath(),
      ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(MIX_SAMPLE_RATE), '-ac', String(MIX_CHANNELS), '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const job: Job = { id, dir, wav, ffmpeg, ffmpegDone: null, whisper: null, cancelled: false };
    job.ffmpegDone = collect(ffmpeg).then(({ code, stderr }) => {
      job.ffmpeg = null;
      if (code !== 0 && !job.cancelled) throw new TranscriptionError('ffmpeg', tail(stderr) || `code ${code}`);
    });
    // A failure is reported when the audio is closed; until then it must not be an unhandled rejection.
    job.ffmpegDone.catch(() => undefined);
    // Writing to a pipe whose reader died raises here, not at the write.
    ffmpeg.stdin?.on('error', () => undefined);
    this.jobs.set(id, job);
    return id;
  }

  async appendAudio(id: string, samples: Uint8Array): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new TranscriptionError('no-job', id);
    const stdin = job.ffmpeg?.stdin;
    if (!stdin || stdin.destroyed) return;
    if (!stdin.write(samples)) await new Promise<void>((resolve) => stdin.once('drain', resolve));
  }

  async closeAudio(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new TranscriptionError('no-job', id);
    job.ffmpeg?.stdin?.end();
    try {
      await job.ffmpegDone;
    } catch (error) {
      await this.finish(job);
      throw error;
    }
  }

  /**
   * Transcribe the job's audio. Always resolves with the job's folder gone:
   * with the words, or as cancelled; a failure is thrown.
   */
  async transcribe(id: string, model: CaptionModel, modelFile: string, language: 'es' | 'en', onProgress: (fraction: number) => void): Promise<TranscriptionOutcome> {
    const job = this.jobs.get(id);
    if (!job) throw new TranscriptionError('no-job', id);
    const started = Date.now();
    try {
      const engine = this.options.engine();
      if (!engine) throw new TranscriptionError('whisper', 'the speech-to-text program is not part of this build');
      const info = await stat(job.wav);
      const audioSeconds = Math.max(0, (info.size - 44) / (16_000 * 2));
      const cancelled = (): TranscriptionOutcome => ({ cancelled: true, words: [], dropped: [], ran: 'cpu', gpu: null, audioSeconds, elapsedSeconds: (Date.now() - started) / 1000 });
      if (job.cancelled) return cancelled();

      let gpu = await this.chooseGpu();
      const output = join(job.dir, 'out');
      for (;;) {
        const { args, env } = whisperCommand({
          model: modelFile,
          dtw: model.dtw,
          audio: job.wav,
          output,
          language,
          threads: threadsFor(cpus().length, gpu !== null && gpu !== 'auto'),
          gpu,
          vadModel: engine.vadModel,
        });
        if (job.cancelled) return cancelled();
        const child = spawn(engine.cli, args, { cwd: engine.dir, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        job.whisper = child;
        // Below the editor: transcribing must not make playback stutter.
        try {
          if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // Not allowed to: it runs at normal priority.
        }
        let usedGpu = false;
        let gpuName: string | null = gpu && gpu !== 'auto' ? gpu.name : null;
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            const fraction = parseProgress(line);
            if (fraction !== null) onProgress(fraction);
            if (/using\s+Vulkan\d*\s+backend/i.test(line)) usedGpu = true;
          }
          if (gpuName === null) gpuName = parseVulkanDevices(text)[0]?.name ?? null;
        });
        const { code, stderr } = await collect(child);
        job.whisper = null;
        if (job.cancelled) return cancelled();
        if (code !== 0) {
          // The GPU could not do it (a driver fault, not enough memory): the
          // processor can, more slowly.
          if (gpu !== null) {
            gpu = null;
            continue;
          }
          throw new TranscriptionError('whisper', tail(stderr) || `code ${code}`);
        }
        const json = JSON.parse(await readFile(`${output}.json`, 'utf8')) as WhisperJson;
        const { words, dropped } = parseWhisperJson(json);
        onProgress(1);
        return { cancelled: false, words, dropped, ran: usedGpu ? 'gpu' : 'cpu', gpu: usedGpu ? gpuName : null, audioSeconds, elapsedSeconds: (Date.now() - started) / 1000 };
      }
    } finally {
      await this.finish(job);
    }
  }

  /** Stop a job wherever it is, and delete its folder. */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    job.ffmpeg?.stdin?.destroy();
    job.ffmpeg?.kill();
    job.whisper?.kill();
    // A transcription in flight deletes the folder itself, once its process is gone.
    if (!job.whisper) await this.finish(job);
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }

  /** Whether any job is running (for the tests, and for quitting). */
  get active(): number {
    return this.jobs.size;
  }

  private async finish(job: Job): Promise<void> {
    this.jobs.delete(job.id);
    job.ffmpeg?.kill();
    // The process may hold the file a moment after it dies (Windows).
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(job.dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
