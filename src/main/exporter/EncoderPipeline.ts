import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExportProgress, ExportSettings } from '@shared/types';
import {
  FORMAT_SUPPORTS_ALPHA,
  resolveFfmpegPath,
  scaleFilterArgs,
  videoCodecArgs,
} from './HardwareAccel';

/**
 * Native FFmpeg pipe exporter.
 *
 * The renderer composites each frame on the GPU, reads it back as straight RGBA
 * and posts it here; this process pipes the raw frames into ffmpeg's stdin. That
 * keeps encoding off the render thread and out of WebAssembly, which is where
 * ffmpeg.wasm would otherwise cost an order of magnitude in throughput.
 */

export type ProgressListener = (progress: ExportProgress) => void;

interface ActiveJob {
  id: string;
  process: ChildProcessWithoutNullStreams;
  settings: ExportSettings;
  totalFrames: number;
  framesWritten: number;
  startedAt: number;
  stderr: string;
  /** Resolves when ffmpeg exits. */
  completion: Promise<void>;
  cancelled: boolean;
}

const MAX_STDERR_CHARS = 16_000;

export class EncoderPipeline {
  private readonly jobs = new Map<string, ActiveJob>();

  constructor(private readonly onProgress: ProgressListener) {}

  /**
   * Build the full ffmpeg argument list.
   *
   * Two shapes, decided by `pipeMode`:
   *
   *   - `rawvideo`   - uncompressed RGBA in, ffmpeg encodes. Preserves alpha.
   *   - `annexb-*`   - an already-encoded elementary stream in, ffmpeg only
   *                    muxes (`-c:v copy`). No alpha, but no re-encode either.
   */
  static buildArgs(settings: ExportSettings): string[] {
    const outputTarget =
      settings.format === 'png-sequence'
        ? join(settings.outputPath, 'frame_%05d.png')
        : settings.outputPath;

    const preamble = ['-hide_banner', '-loglevel', 'error', '-stats_period', '0.5'];

    // A PNG sequence is a pile of stills; there is nothing to attach audio to.
    const withAudio = Boolean(settings.audioPath) && settings.format !== 'png-sequence';

    /**
     * Audio arrives as a second input rather than through the pipe, so the
     * streams have to be mapped explicitly - otherwise ffmpeg picks one stream
     * per type by its own rules.
     *
     * `-shortest` is deliberately NOT used. A WebCodecs Annex-B elementary
     * stream carries no timestamps, so copied video packets reach the muxer
     * with no PTS ("Timestamps are unset in a packet for stream 0"), and
     * `-shortest` then resolves the video length as nothing and writes zero
     * bytes of audio - producing a silent file with a perfectly well-formed
     * AAC stream declared in its header.
     *
     * The mix is instead rendered to exactly the picture duration, so both
     * inputs end together and no truncation flag is needed.
     */
    const audioArgs = withAudio
      ? [
          '-i',
          settings.audioPath as string,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:a',
          'aac',
          '-b:a',
          `${settings.audioBitrateKbps ?? 256}k`,
          '-ar',
          '48000',
        ]
      : [];

    if (settings.pipeMode === 'annexb-h264' || settings.pipeMode === 'annexb-hevc') {
      const streamFormat = settings.pipeMode === 'annexb-h264' ? 'h264' : 'hevc';
      return [
        ...preamble,
        '-f',
        streamFormat,
        '-framerate',
        String(settings.fps),
        '-i',
        'pipe:0',
        ...audioArgs,
        // The renderer already encoded these frames; re-encoding would throw
        // away the whole point of the WebCodecs path.
        '-c:v',
        'copy',
        ...(settings.pipeMode === 'annexb-hevc' ? ['-tag:v', 'hvc1'] : []),
        '-movflags',
        '+faststart',
        '-y',
        outputTarget,
      ];
    }

    return [
      ...preamble,
      // Raw input description.
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgba',
      '-video_size',
      `${settings.width}x${settings.height}`,
      '-framerate',
      String(settings.fps),
      '-i',
      'pipe:0',
      ...audioArgs,
      ...scaleFilterArgs(settings),
      ...videoCodecArgs(settings),
      '-r',
      String(settings.fps),
      '-y',
      outputTarget,
    ];
  }

  /** Frames the renderer is expected to push. */
  static frameCount(settings: ExportSettings): number {
    return Math.max(0, settings.endFrame - settings.startFrame);
  }

  async start(settings: ExportSettings): Promise<string> {
    if (!settings.outputPath) throw new Error('Export needs an output path');

    // A PNG sequence writes into a directory; every other format writes a file.
    const directory =
      settings.format === 'png-sequence' ? settings.outputPath : dirname(settings.outputPath);
    await mkdir(directory, { recursive: true });

    const id = randomUUID();
    const args = EncoderPipeline.buildArgs(settings);
    const child = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const job: ActiveJob = {
      id,
      process: child,
      settings,
      totalFrames: EncoderPipeline.frameCount(settings),
      framesWritten: 0,
      startedAt: Date.now(),
      stderr: '',
      cancelled: false,
      completion: Promise.resolve(),
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      job.stderr = (job.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    job.completion = new Promise<void>((resolve, reject) => {
      child.once('error', (error) => {
        this.emit(job, { error: error.message, done: true });
        reject(error);
      });

      child.once('close', (code) => {
        this.jobs.delete(id);
        // The mix was written to temp purely to be an ffmpeg input.
        if (settings.audioPath) void rm(settings.audioPath, { force: true });
        if (job.cancelled) {
          resolve();
          return;
        }
        if (code === 0) {
          this.emit(job, { done: true });
          resolve();
          return;
        }
        const message = `ffmpeg exited with code ${code}\n${job.stderr}`;
        this.emit(job, { error: message, done: true });
        reject(new Error(message));
      });
    });

    // An unhandled rejection here would tear down the app; the promise is
    // awaited by `finish()` instead.
    job.completion.catch(() => undefined);

    this.jobs.set(id, job);
    return id;
  }

  private emit(job: ActiveJob, patch: Partial<ExportProgress> = {}): void {
    const elapsedSeconds = (Date.now() - job.startedAt) / 1000;
    this.onProgress({
      jobId: job.id,
      frame: job.framesWritten,
      totalFrames: job.totalFrames,
      fps: elapsedSeconds > 0 ? job.framesWritten / elapsedSeconds : 0,
      done: false,
      ...patch,
    });
  }

  /**
   * Write one frame, respecting backpressure.
   *
   * Without the drain wait, a fast compositor outruns the encoder and the raw
   * frames pile up in memory - at 4K/RGBA that is 33 MB per second of footage.
   */
  async writeFrame(jobId: string, frame: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown export job "${jobId}"`);

    // Raw frames have a fixed size, so a mismatch means the renderer and the
    // encoder disagree about the resolution - worth catching loudly. Encoded
    // chunks are variable length by nature.
    if (job.settings.pipeMode === 'rawvideo') {
      const expectedBytes = job.settings.width * job.settings.height * 4;
      if (frame.byteLength !== expectedBytes) {
        throw new Error(
          `Frame size mismatch: expected ${expectedBytes} bytes for ` +
            `${job.settings.width}x${job.settings.height} RGBA, received ${frame.byteLength}`,
        );
      }
    }

    const flushed = job.process.stdin.write(frame);
    if (!flushed) {
      await new Promise<void>((resolve) => job.process.stdin.once('drain', resolve));
    }

    job.framesWritten += 1;
    if (job.framesWritten % 5 === 0 || job.framesWritten === job.totalFrames) {
      this.emit(job);
    }
  }

  /** Close stdin and wait for the encoder to flush and exit. */
  async finish(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    await new Promise<void>((resolve) => job.process.stdin.end(resolve));
    await job.completion;
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.cancelled = true;
    job.process.stdin.destroy();
    job.process.kill('SIGKILL');
    this.jobs.delete(jobId);
    this.emit(job, { done: true, error: 'Export cancelled' });
  }

  /** Kill every running encoder, e.g. on window close. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }

  /** True when the settings ask for alpha the chosen container cannot store. */
  static willDropAlpha(settings: ExportSettings): boolean {
    return settings.exportAlpha && !FORMAT_SUPPORTS_ALPHA[settings.format];
  }
}
