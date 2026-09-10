import type { ExportPipeMode, ExportSettings } from '@shared/types';

/**
 * GPU-side encoding with the WebCodecs `VideoEncoder`.
 *
 * The raw path reads every composited frame back with `readPixels` and ships
 * uncompressed RGBA to the main process - about 33 MB per second of 4K footage
 * across the IPC boundary. Here the frame never leaves the GPU as pixels: a
 * `VideoFrame` is constructed straight from the canvas, the platform encoder
 * compresses it, and only the resulting chunks cross the boundary, where ffmpeg
 * just muxes them.
 *
 * The tradeoff is alpha: no browser video encoder carries an alpha plane, so
 * this path is only ever selected for the opaque delivery formats.
 */

/**
 * Codec candidates, most preferred first.
 *
 * Levels matter: a 4K stream declared at an HD level is rejected by some
 * encoders, so each family lists a high level first and falls back down.
 */
const H264_CANDIDATES = [
  'avc1.640033', // High profile, level 5.1 - covers 4K
  'avc1.640028', // High profile, level 4.0
  'avc1.4d0028', // Main profile, level 4.0
  'avc1.42e01e', // Baseline - the universal fallback
];

const HEVC_CANDIDATES = ['hev1.1.6.L153.B0', 'hev1.1.6.L123.B0', 'hev1.1.6.L93.B0'];

export interface CodecSupport {
  pipeMode: ExportPipeMode;
  codec: string;
}

/** Formats the WebCodecs path is allowed to handle at all. */
export function isWebCodecsEligible(settings: ExportSettings): boolean {
  if (settings.exportAlpha) return false; // No browser encoder carries alpha.
  if (settings.pixelArtScaling) return false; // Scaling filter lives in ffmpeg.
  return settings.format === 'mp4-h264' || settings.format === 'mp4-h265';
}

/**
 * Probe the platform for a usable encoder configuration.
 *
 * Returns `null` when WebCodecs is unavailable or nothing supports the
 * requested resolution, in which case the caller uses the raw RGBA path.
 */
export async function detectCodecSupport(
  settings: ExportSettings,
): Promise<CodecSupport | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  if (!isWebCodecsEligible(settings)) return null;

  const candidates =
    settings.format === 'mp4-h265'
      ? [...HEVC_CANDIDATES, ...H264_CANDIDATES]
      : H264_CANDIDATES;

  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: settings.width,
        height: settings.height,
        bitrate: Math.max(500, settings.bitrateKbps) * 1000,
        framerate: settings.fps,
        // Annex-B so ffmpeg can read the stream with `-f h264` and copy it.
        ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' as const } } : {}),
        ...(codec.startsWith('hev1') ? { hevc: { format: 'annexb' as const } } : {}),
      });

      if (support.supported) {
        return {
          codec,
          pipeMode: codec.startsWith('hev1') ? 'annexb-hevc' : 'annexb-h264',
        };
      }
    } catch {
      // An unrecognised codec string throws rather than reporting unsupported.
    }
  }

  return null;
}

/** Keep the encoder queue shallow so memory does not balloon during a render. */
const MAX_QUEUE_DEPTH = 8;

export interface EncoderCallbacks {
  onChunk(bytes: Uint8Array): Promise<void> | void;
  onError(error: Error): void;
}

export class WebCodecsEncoder {
  private readonly encoder: VideoEncoder;
  private readonly keyFrameInterval: number;
  private frameIndex = 0;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(
    private readonly settings: ExportSettings,
    support: CodecSupport,
    callbacks: EncoderCallbacks,
  ) {
    // A keyframe every two seconds keeps the file seekable without bloating it.
    this.keyFrameInterval = Math.max(1, Math.round(settings.fps * 2));

    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // Chunk delivery is synchronous, but forwarding it is not; chaining
        // keeps the elementary stream in order.
        this.pending = this.pending.then(() => callbacks.onChunk(bytes));
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        callbacks.onError(this.failure);
      },
    });

    this.encoder.configure({
      codec: support.codec,
      width: settings.width,
      height: settings.height,
      bitrate: Math.max(500, settings.bitrateKbps) * 1000,
      framerate: settings.fps,
      latencyMode: 'quality',
      ...(support.codec.startsWith('avc1') ? { avc: { format: 'annexb' as const } } : {}),
      ...(support.codec.startsWith('hev1') ? { hevc: { format: 'annexb' as const } } : {}),
    });
  }

  /** Microsecond presentation timestamp for a given frame index. */
  private timestampFor(index: number): number {
    return Math.round((index * 1_000_000) / this.settings.fps);
  }

  /**
   * Encode the current canvas contents.
   *
   * The canvas must already hold the composited frame; the compositor is
   * configured with `preserveDrawingBuffer`, so its contents survive until the
   * next draw.
   */
  async encodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    if (this.failure) throw this.failure;

    // Backpressure: let the encoder drain before queuing more work.
    while (this.encoder.encodeQueueSize > MAX_QUEUE_DEPTH) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (this.failure) throw this.failure;
    }

    const frame = new VideoFrame(canvas as CanvasImageSource, {
      timestamp: this.timestampFor(this.frameIndex),
      duration: Math.round(1_000_000 / this.settings.fps),
    });

    try {
      this.encoder.encode(frame, {
        keyFrame: this.frameIndex % this.keyFrameInterval === 0,
      });
    } finally {
      // A VideoFrame holds a GPU buffer; failing to close it leaks hard.
      frame.close();
    }

    this.frameIndex += 1;
  }

  /** Flush the encoder and wait for every chunk to be forwarded. */
  async finish(): Promise<void> {
    if (this.failure) throw this.failure;

    await this.encoder.flush();
    await this.pending;
    this.encoder.close();

    if (this.failure) throw this.failure;
  }

  /** Abort without waiting for a flush. */
  close(): void {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}
