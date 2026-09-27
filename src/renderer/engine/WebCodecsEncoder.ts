import type { ExportPipeMode, ExportSettings, StreamColour } from '@shared/types';

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

/** The one configuration the export and the colour measurement both use. */
function encoderConfigFor(settings: ExportSettings, support: CodecSupport): VideoEncoderConfig {
  return {
    codec: support.codec,
    width: settings.width,
    height: settings.height,
    bitrate: Math.max(500, settings.bitrateKbps) * 1000,
    framerate: settings.fps,
    latencyMode: 'quality',
    ...(support.codec.startsWith('avc1') ? { avc: { format: 'annexb' as const } } : {}),
    ...(support.codec.startsWith('hev1') ? { hevc: { format: 'annexb' as const } } : {}),
  };
}

/**
 * Luma of pure red, 8-bit, under each matrix and range an encoder might use.
 * Red is where BT.601 and BT.709 differ most: 0.299 against 0.2126.
 */
const RED_LUMA: ReadonlyArray<{ colour: StreamColour; y: number }> = [
  { colour: { matrix: 'bt709', fullRange: false }, y: 63 }, // 16 + 219 * 0.2126
  { colour: { matrix: 'bt601', fullRange: false }, y: 81 }, // 16 + 219 * 0.299
  { colour: { matrix: 'bt709', fullRange: true }, y: 54 }, // 255 * 0.2126
  { colour: { matrix: 'bt601', fullRange: true }, y: 76 }, // 255 * 0.299
];

/** The matrix a measured luma of red belongs to, or null when none is close. */
export function classifyRedLuma(y: number): StreamColour | null {
  let best: { colour: StreamColour; y: number } | null = null;
  for (const candidate of RED_LUMA) {
    if (!best || Math.abs(candidate.y - y) < Math.abs(best.y - y)) best = candidate;
  }
  return best && Math.abs(best.y - y) <= 3 ? best.colour : null;
}

const measuredColour = new Map<string, Promise<StreamColour | null>>();

/**
 * Which matrix and range the platform encoder converts RGB with.
 *
 * A `VideoFrame` made from the canvas is RGB, and the encoder turns it into
 * YUV by rules of its own and tags nothing. On the reference machine it used
 * BT.601, so a player reading the untagged HD file as BT.709 showed pure
 * green as 0,214,0. There is no setting for it in WebCodecs, so it is
 * measured instead: one frame of pure red, encoded with the export's own
 * configuration and decoded again in software, and the luma it came back
 * with says the matrix. The muxer then tags the stream to match.
 *
 * Once per configuration per session. Null when it cannot be measured, and
 * the stream is then left as the encoder wrote it.
 */
export function measureStreamColour(settings: ExportSettings, support: CodecSupport): Promise<StreamColour | null> {
  const key = `${support.codec}|${settings.width}x${settings.height}`;
  let measured = measuredColour.get(key);
  if (!measured) {
    measured = measureOnce(settings, support).catch(() => null);
    measuredColour.set(key, measured);
  }
  return measured;
}

async function measureOnce(settings: ExportSettings, support: CodecSupport): Promise<StreamColour | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return null;
  }
  const { width, height } = settings;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, width, height);

  const chunks: EncodedVideoChunk[] = [];
  const encoder = new VideoEncoder({ output: (chunk) => chunks.push(chunk), error: () => undefined });
  try {
    encoder.configure(encoderConfigFor(settings, support));
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (chunks.length === 0) return null;

  let decoded: VideoFrame | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (decoded) frame.close();
      else decoded = frame;
    },
    error: () => undefined,
  });
  try {
    // Software, so the frame lands in memory as planes that can be read.
    decoder.configure({ codec: support.codec, codedWidth: width, codedHeight: height, hardwareAcceleration: 'prefer-software' });
    decoder.decode(chunks[0]);
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  const picture = decoded as VideoFrame | null;
  if (!picture) return null;
  try {
    if (picture.format !== 'I420' && picture.format !== 'NV12') return null;
    const bytes = new Uint8Array(picture.allocationSize());
    const layout = await picture.copyTo(bytes);
    const luma = layout[0];
    const y = bytes[luma.offset + Math.floor(height / 2) * luma.stride + Math.floor(width / 2)];
    return classifyRedLuma(y);
  } finally {
    picture.close();
  }
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

/**
 * Frames allowed to wait in the encoder.
 *
 * A depth of 8 drained by a 4 ms timer was the single biggest cost of an
 * export: measured over 2816 frames, 1326 of them blocked on the timer
 * rather than on the encoder, which ran at 383 fps. Waiting on the
 * `dequeue` event with a deeper queue reached 428 fps, and only then did
 * the queue actually fill - that is the encoder's own ceiling.
 *
 * Scaled by frame area, because the queue holds whole frames and 4K ones
 * are nine times the memory of 720p.
 */
function queueDepthFor(width: number, height: number): number {
  const pixels = Math.max(1, width * height);
  if (pixels <= 1280 * 720) return 64;
  if (pixels <= 1920 * 1080) return 32;
  return 12;
}

export interface EncoderCallbacks {
  onChunk(bytes: Uint8Array): Promise<void> | void;
  onError(error: Error): void;
}

export class WebCodecsEncoder {
  private readonly encoder: VideoEncoder;
  private readonly keyFrameInterval: number;
  private readonly queueDepth: number;
  private frameIndex = 0;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  /** Set by `close`: nothing queued is forwarded after it. */
  private closed = false;

  constructor(
    private readonly settings: ExportSettings,
    support: CodecSupport,
    callbacks: EncoderCallbacks,
  ) {
    // A keyframe every two seconds keeps the file seekable without bloating it.
    this.keyFrameInterval = Math.max(1, Math.round(settings.fps * 2));


    this.queueDepth = queueDepthFor(settings.width, settings.height);

    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // Chunk delivery is synchronous, but forwarding it is not; chaining
        // keeps the elementary stream in order.
        this.pending = this.pending
          .then(() => (this.closed ? undefined : callbacks.onChunk(bytes)))
          .catch((error: unknown) => {
            // After a cancel a late write failing is expected and harmless.
            // Before one it is a real failure: kept for `finish` to throw,
            // rather than escaping as an unhandled rejection nobody awaits.
            if (this.closed || this.failure) return;
            this.failure = error instanceof Error ? error : new Error(String(error));
            callbacks.onError(this.failure);
          });
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        callbacks.onError(this.failure);
      },
    });

    this.encoder.configure(encoderConfigFor(settings, support));
  }

  /** Microsecond presentation timestamp for a given frame index. */
  /**
   * Resolves when the encoder has taken something off its queue.
   *
   * `dequeue` exists for exactly this; polling with a timer put a 4 ms floor
   * under every frame that found the queue full. The timer here is only a
   * backstop, so a queue that never drains cannot hang an export.
   */
  private queueDrained(): Promise<void> {
    return new Promise((resolve) => {
      const { encoder } = this;
      const done = (): void => {
        encoder.removeEventListener('dequeue', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 50);
      encoder.addEventListener('dequeue', done);
    });
  }

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

    // Snapshot the canvas FIRST, synchronously, while it still holds the frame
    // that was just rendered. Waiting on backpressure before the snapshot
    // yields to the event loop, and anything that draws into the canvas in that
    // gap - the viewport, for one - becomes this frame instead.
    const frame = new VideoFrame(canvas as CanvasImageSource, {
      timestamp: this.timestampFor(this.frameIndex),
      duration: Math.round(1_000_000 / this.settings.fps),
    });

    await this.submit(frame);
  }

  /**
   * Wait for room in the encoder, hand the frame over, and release it.
   *
   * Reading the pixels back and encoding from a buffer instead was tried
   * here: measured on its own it looked twice as fast, but in the real
   * export loop it came out slower (33.7 s against 30.7 s for the same
   * render), because the readback stalls the GPU pipeline for about as long
   * as the refresh it avoids. The cap this was meant to dodge is lifted in
   * the main process instead - see `disable-gpu-vsync` there.
   */
  private async submit(frame: VideoFrame): Promise<void> {
    try {
      // Backpressure: let the encoder drain before queuing more work.
      while (this.encoder.encodeQueueSize > this.queueDepth) {
        if (this.failure) throw this.failure;
        await this.queueDrained();
      }

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
    this.closed = true;
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}
