/**
 * Serializable project data schema.
 *
 * Everything in this file must survive `JSON.stringify` / `JSON.parse` without
 * loss: the project file, the undo/redo history snapshots and the IPC bridge to
 * the export pipeline all move these structures across process boundaries.
 */

export type TrackType = 'video' | 'audio' | 'text' | 'adjustment';

export interface Vector2D {
  x: number;
  y: number;
}

export interface BezierCurve {
  cp1: Vector2D; // Control Point 1
  cp2: Vector2D; // Control Point 2
}

/** Values a keyframe track is allowed to animate. */
export type KeyframeValue = Vector2D | number;

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'bezier';

export interface Keyframe<T extends KeyframeValue = number> {
  id: string;
  frame: number;
  value: T;
  easing: Easing;
  bezierParams?: BezierCurve;
}

export interface ClipTransform {
  position: Keyframe<Vector2D>[];
  scale: Keyframe<Vector2D>[];
  rotation: Keyframe<number>[]; // In degrees
  opacity: Keyframe<number>[]; // 0.0 to 1.0
  anchorPoint: Vector2D;
}

export interface MaskConfig {
  enabled: boolean;
  type: 0 | 1 | 2; // 0 = Off, 1 = Rectangle, 2 = Ellipse
  center: Vector2D; // Normalized (0.0 to 1.0)
  size: Vector2D; // Normalized (0.0 to 1.0)
  rotation: number; // Radians
  cornerRadius: number; // Normalized
  feather: number; // Pixels
  invert: boolean;
}

export interface ColorGradingConfig {
  enabled: boolean;
  exposure: number; // -2.0 to 2.0
  contrast: number; // 0.0 to 2.0
  saturation: number; // 0.0 to 2.0
  temperature: number; // -1.0 to 1.0
  tint: number; // -1.0 to 1.0
  lutUri?: string;
  lutIntensity: number; // 0.0 to 1.0
}

/** Green / blue screen removal, applied before masking. */
export interface ChromaKeyConfig {
  enabled: boolean;
  keyColor: [number, number, number]; // Linear RGB, 0.0 to 1.0
  similarity: number; // 0.0 to 1.0
  smoothness: number; // 0.0 to 1.0
  spill: number; // 0.0 to 1.0 - desaturation of the key hue in edge pixels
}

/** Nearest-neighbour / pixelization pass used for sprite authoring. */
export interface PixelArtConfig {
  enabled: boolean;
  pixelSize: number; // Source pixels collapsed into one output pixel
  paletteSteps: number; // 0 = no quantization, otherwise levels per channel
  alphaThreshold: number; // Alpha below this is cut to 0 to keep sprites crisp
}

export interface Clip {
  id: string;
  trackId: string;
  name: string;
  sourceUri: string;
  startFrame: number; // In Timeline space
  durationFrames: number; // In Timeline space
  sourceOffsetFrames: number; // In Source Media space
  hasAlphaChannel: boolean; // Support for transparent PNG/WebM sprites
  transform: ClipTransform;
  mask: MaskConfig;
  colorGrading: ColorGradingConfig;
  chromaKey: ChromaKeyConfig;
  pixelArt: PixelArtConfig;
  /** Linear gain for audio-bearing clips, 0.0 to 2.0. */
  volume: number;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  order: number;
}

/** Frame rates offered in the project settings UI. */
export const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

export interface ProjectState {
  /**
   * Timeline frame rate.
   *
   * Widened from the original `24 | 30 | 60` on purpose: 25 and 50 fps (PAL)
   * and the 23.976/29.97 pulldown rates are ordinary source material, and
   * forcing them onto one of three values resamples the footage silently -
   * which reads to the eye as the export having "lost" frames.
   */
  fps: number;
  width: number;
  height: number;
  durationFrames: number;
  currentFrame: number;
  tracks: Track[];
  clips: Record<string, Clip>;
  hasAlphaBackground: boolean; // Transparent Canvas for Godot Sprite Exports
}

/* -------------------------------------------------------------------------- */
/* Media library                                                              */
/* -------------------------------------------------------------------------- */

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  name: string;
  /**
   * Blob URL used by the renderer. Object URLs do not survive a reload, so this
   * is rebuilt from `sourcePath` when a project is reopened.
   */
  uri: string;
  /**
   * Absolute path on disk, when the file came in through a native dialog. This
   * is what makes a saved project reopenable; files dropped into a browser have
   * no path and are marked `missing` on reload.
   */
  sourcePath?: string;
  kind: MediaKind;
  durationFrames: number;
  width: number;
  height: number;
  hasAlphaChannel: boolean;
  /** Frame rate of the source material, when it could be determined. */
  sourceFps?: number;
  /** Data URL of a poster frame, when one has been decoded. */
  thumbnailUri?: string;
  /** Set when a reopened project could not restore this asset from disk. */
  missing?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Containers that carry a real alpha channel are the ones a game engine can
 * consume directly; `mp4` is listed for delivery renders and flattens alpha.
 */
export type ExportFormat = 'png-sequence' | 'prores4444' | 'webm-vp9' | 'mp4-h264' | 'mp4-h265';

export type HardwareEncoder = 'none' | 'nvenc' | 'qsv' | 'videotoolbox' | 'amf';

/**
 * How frames reach ffmpeg's stdin.
 *
 * `rawvideo` sends uncompressed RGBA - the only option that preserves alpha,
 * but ~33 MB per second of 4K footage across the process boundary. The
 * `annexb-*` modes let a WebCodecs `VideoEncoder` compress on the GPU first, so
 * ffmpeg only has to mux (`-c:v copy`). Those cannot carry alpha.
 */
export type ExportPipeMode = 'rawvideo' | 'annexb-h264' | 'annexb-hevc';

export interface ExportSettings {
  format: ExportFormat;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  startFrame: number;
  endFrame: number;
  /** "Export Alpha Channel" toggle. Ignored by formats that cannot carry it. */
  exportAlpha: boolean;
  /**
   * Godot imports straight (non-premultiplied) alpha. Leaving this off is what
   * prevents dark fringing around exported sprites.
   */
  premultiplyAlpha: boolean;
  /** Nearest-neighbour scaling for pixel-art sprite sheets. */
  pixelArtScaling: boolean;
  bitrateKbps: number;
  hardwareEncoder: HardwareEncoder;
  /**
   * Chosen automatically from the format and the browser's codec support;
   * `rawvideo` is always the safe fallback.
   */
  pipeMode: ExportPipeMode;
  /**
   * Temporary WAV holding the rendered audio mix, muxed as a second input.
   * Absent for a silent timeline or a format that carries no audio.
   */
  audioPath?: string;
  audioBitrateKbps?: number;
}

export interface ExportProgress {
  jobId: string;
  frame: number;
  totalFrames: number;
  fps: number;
  done: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Shader-side types                                                          */
/* -------------------------------------------------------------------------- */

/** Resolved (non-animated) values handed to the GPU for a single frame. */
export interface ResolvedTransform {
  position: Vector2D;
  scale: Vector2D;
  rotation: number; // Degrees
  opacity: number;
  anchorPoint: Vector2D;
}

export interface CubeLUT {
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** RGB triplets in x-fastest order, length === size ** 3 * 3. */
  data: Float32Array;
}
