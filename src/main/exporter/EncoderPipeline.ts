import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
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
  /** Where ffmpeg actually writes until the export succeeds. */
  destination: string;
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
  static buildArgs(settings: ExportSettings, destination = settings.outputPath): string[] {
    const outputTarget =
      settings.format === 'png-sequence'
        ? join(destination, 'frame_%05d.png')
        : destination;

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
          // A streamed mix is headerless float32: ffmpeg has to be told what it is.
          ...(settings.audioRawFormat
            ? ['-f', 'f32le', '-ar', String(settings.audioRawFormat.sampleRate), '-ac', String(settings.audioRawFormat.channels)]
            : []),
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
        // Stamp frame N at exactly N/fps. An Annex-B stream carries no
        // timestamps, and the ones ffmpeg makes up for it run fast: durations
        // alternate 40000/39999 ticks, an hour ended 36 ms (more than a frame)
        // ahead of its sound, and where the drift crossed half a frame two
        // frames rounded onto the same time. Counted from the packets, not
        // accumulated, so no drift can build up.
        '-bsf:v',
        `setts=ts=N/(${settings.fps}*TB)`,
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

  /**
   * Where an export writes before it has earned the destination.
   *
   * ffmpeg is given `-y` and writes the container as it goes, patching the
   * `mdat` length and appending `moov` only at the very end. So the moment an
   * export starts, whatever used to be at the destination is gone, and if the
   * export is then cancelled what is left is an MP4 with no index: unopenable,
   * and no longer the file that was there before. Two of the user's own
   * recordings were destroyed exactly that way, because the export name
   * defaults to the footage's name and the folder was the footage's folder.
   *
   * A sidecar next to the destination - same volume, so the publish is an
   * atomic rename rather than a copy - means nothing is overwritten until the
   * encode has exited 0.
   */
  static partialPathFor(outputPath: string): string {
    return `${outputPath}.part${extname(outputPath)}`;
  }

  async start(settings: ExportSettings): Promise<string> {
    if (!settings.outputPath) throw new Error('Export needs an output path');

    // A PNG sequence writes into a directory; every other format writes a file.
    const directory =
      settings.format === 'png-sequence' ? settings.outputPath : dirname(settings.outputPath);
    await mkdir(directory, { recursive: true });

    const id = randomUUID();
    // A PNG sequence fills a directory the user chose, so there is nothing to
    // overwrite and nothing to publish; every other format goes via a sidecar.
    const destination =
      settings.format === 'png-sequence'
        ? settings.outputPath
        : EncoderPipeline.partialPathFor(settings.outputPath);
    const args = EncoderPipeline.buildArgs(settings, destination);
    const child = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const job: ActiveJob = {
      id,
      process: child,
      settings,
      destination,
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
        // A cancelled or failed encode leaves a half-written sidecar. It is
        // never the destination, so removing it loses nothing.
        const discardPartial = (): void => {
          if (job.destination !== settings.outputPath) void rm(job.destination, { force: true });
        };
        if (job.cancelled) {
          discardPartial();
          resolve();
          return;
        }
        if (code === 0) {
          this.emit(job, { done: true });
          resolve();
          return;
        }
        discardPartial();
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
   * Jobs cancelled this session. Chunks the renderer had already queued keep
   * arriving for a moment after a cancel, and a write to a job that was
   * deliberately stopped is not an error worth throwing back.
   */
  private readonly cancelledJobs = new Set<string>();

  /**
   * Write one frame, respecting backpressure.
   *
   * Without the drain wait, a fast compositor outruns the encoder and the raw
   * frames pile up in memory - at 4K/RGBA that is 33 MB per second of footage.
   */
  async writeFrame(jobId: string, frame: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      if (this.cancelledJobs.has(jobId)) return;
      throw new Error(`Unknown export job "${jobId}"`);
    }
    if (job.cancelled) return;

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

    const stdin = job.process.stdin;
    const flushed = stdin.write(frame);
    if (!flushed) {
      // Not only 'drain': a cancel destroys stdin and kills the encoder, and
      // then drain never comes. The write used to wait for it forever, the
      // reply to the renderer was dropped, and the page logged "reply was
      // never sent" from a render that had been cancelled cleanly.
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          stdin.off('drain', settle);
          stdin.off('close', settle);
          stdin.off('error', settle);
          resolve();
        };
        stdin.once('drain', settle);
        stdin.once('close', settle);
        stdin.once('error', settle);
      });
    }
    if (job.cancelled) return;

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

    const { thumbnailPath, outputPath, format } = job.settings;
    if (thumbnailPath && EncoderPipeline.supportsCoverArt(format)) {
      await EncoderPipeline.attachCoverArt(job.destination, thumbnailPath);
    }

    // Only now, with a complete and indexed file in hand, does the destination
    // get replaced. Until this line the previous file is still intact.
    if (job.destination !== outputPath) await rename(job.destination, outputPath);
  }

  /** Containers that carry a cover image players and Explorer show. */
  static supportsCoverArt(format: ExportSettings['format']): boolean {
    return format === 'mp4-h264' || format === 'mp4-h265' || format === 'prores4444';
  }

  /**
   * ffmpeg arguments that copy `input` untouched and add `image` as its cover.
   *
   * A second pass rather than a second input to the main encode: the main
   * encode sets `-c:v` for every video stream, so a cover added there would be
   * encoded as H.264 with the film. Here every existing stream is stream-copied
   * (fast, lossless) and only the image is encoded, as JPEG, scaled down to at
   * most 1280 px wide, and marked `attached_pic` - the flag that makes it a
   * thumbnail rather than a second video track.
   */
  static coverArtArgs(input: string, image: string, output: string): string[] {
    return [
      '-v', 'error', '-y',
      '-i', input,
      '-i', image,
      '-map', '0',
      '-map', '1:v:0',
      '-c', 'copy',
      '-c:v:1', 'mjpeg',
      '-filter:v:1', "scale='min(1280,iw)':-2",
      '-disposition:v:1', 'attached_pic',
      output,
    ];
  }

  static async attachCoverArt(outputPath: string, image: string): Promise<void> {
    const temporary = `${outputPath}.cover${extname(outputPath)}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolveFfmpegPath(), EncoderPipeline.coverArtArgs(outputPath, image, temporary), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Adding the thumbnail failed: ${stderr.trim().slice(0, 300)}`)),
      );
    });
    await rename(temporary, outputPath);
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.cancelled = true;
    this.cancelledJobs.add(jobId);
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
