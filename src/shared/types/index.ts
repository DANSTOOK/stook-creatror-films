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
  /** Blob URL for this session. Does not survive a reload. */
  lutUri?: string;
  /**
   * Path on disk the LUT came from. This is what makes a look survive being
   * saved and reopened; `lutUri` is rebuilt from it.
   */
  lutSourcePath?: string;
  /** Shown in the inspector so a loaded look is identifiable. */
  lutName?: string;
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

/* -------------------------------------------------------------------------- */
/* Audio                                                                      */
/* -------------------------------------------------------------------------- */

/** Three-band shelving/peaking EQ, in dB of gain per band. */
export interface EqSettings {
  low: number; // dB at 120 Hz (low shelf)
  mid: number; // dB at 1 kHz (peaking)
  high: number; // dB at 8 kHz (high shelf)
}

export const NEUTRAL_EQ: EqSettings = { low: 0, mid: 0, high: 0 };

/**
 * Which sub-bus a track feeds.
 *
 * This used to be sniffed from the track name (anything containing "dialog"
 * went to the dialogue bus), which meant renaming a track silently re-routed
 * it and there was no way to duck against a track called "VO". It is an
 * explicit property now.
 */
export type AudioBus = 'music' | 'dialogue';

/** Sidechain compression ("auto ducking") parameters. */
export interface DuckingParams {
  /** Level above which ducking engages, in dBFS. */
  thresholdDb: number;
  /** How far the music is pulled down at full duck, in dB (positive number). */
  rangeDb: number;
  /** Seconds to reach full duck. */
  attackSeconds: number;
  /** Seconds to recover to unity. */
  releaseSeconds: number;
}

export const DEFAULT_DUCKING: DuckingParams = {
  thresholdDb: -32,
  rangeDb: 12,
  attackSeconds: 0.08,
  releaseSeconds: 0.45,
};

export interface DuckingSettings extends DuckingParams {
  enabled: boolean;
}

/** Mixer state that belongs to the project rather than to the session. */
export interface ProjectAudioState {
  /** Linear gain on the master bus, 0.0 to 2.0. */
  masterVolume: number;
  ducking: DuckingSettings;
}

export const DEFAULT_PROJECT_AUDIO: ProjectAudioState = {
  masterVolume: 1,
  ducking: { ...DEFAULT_DUCKING, enabled: false },
};

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A named point on the timeline.
 *
 * Markers live in the project, not in the editor's UI state: they are authored
 * content, they survive a save, and moving one is an undoable edit like any
 * other.
 */
export interface Marker {
  id: string;
  frame: number;
  label: string;
  /** Hex colour of the ruler flag. */
  color: string;
}

export const DEFAULT_MARKER_COLOR = '#facc15';

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
  /** Stereo position, -1 hard left to +1 hard right. */
  pan: number;
  /** Per-clip corrective EQ, applied before the track strip. */
  eq: EqSettings;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  order: number;
  /** Linear gain of the track strip, 0.0 to 2.0. */
  volume: number;
  /** Stereo position of the track strip, -1 to +1. */
  pan: number;
  /**
   * Solo. When any track is soloed, every non-soloed track is silent - which
   * is a different thing from being muted, and has to stay separate so
   * un-soloing restores the mute states the user actually set.
   */
  solo: boolean;
  /** Sub-bus this track feeds, which is what the ducking sidechain keys off. */
  bus: AudioBus;
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
  /** Named points on the timeline. Sorted by frame. */
  markers: Marker[];
  /** Master bus and auto-ducking, i.e. everything the mixer owns. */
  audio: ProjectAudioState;
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
  /**
   * The audio track alone, extracted by ffmpeg, for decoding. Decoding needs
   * the whole encoded file in memory, and for a long video the whole file is
   * gigabytes of pictures; this is megabytes. Session-only, like `uri`.
   */
  audioUri?: string;
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

/**
 * Which encoder a render uses.
 *
 * `none` is the CPU (libx264 / libx265). `auto` is resolved at export time by
 * `resolveEncoderPlan`, never sent to ffmpeg as is.
 */
export type HardwareEncoder = 'auto' | 'none' | 'nvenc' | 'qsv' | 'videotoolbox' | 'amf';

/** A hardware encoder ffmpeg can drive, as opposed to the two pseudo-choices. */
export type GpuEncoder = Exclude<HardwareEncoder, 'auto' | 'none'>;

/* -------------------------------------------------------------------------- */
/* Graphics hardware                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which GPU Chromium composites on.
 *
 * Applied as a command-line switch before the app is ready, so a change only
 * takes effect after a restart. `auto` leaves the choice to the OS.
 */
export type GpuPreference = 'auto' | 'high-performance' | 'low-power';

export type GpuVendor = 'nvidia' | 'intel' | 'amd' | 'apple' | 'other';

export interface GpuDevice {
  vendorId: number;
  deviceId: number;
  vendor: GpuVendor;
  /** Marketing name, e.g. "NVIDIA GeForce RTX 4060 Laptop GPU". */
  name: string;
  /** How the OS classifies it: its high-performance or its power-saving GPU. */
  kind: 'dedicated' | 'integrated' | 'unknown';
  /** True for the GPU the compositor is running on right now. */
  active: boolean;
}

/** A hardware encoder that was actually exercised and produced frames. */
export interface EncoderOption {
  encoder: GpuEncoder;
  /** The GPU that runs it, when one could be matched. */
  gpu: GpuDevice | null;
}

export interface GpuReport {
  devices: GpuDevice[];
  /** The preference saved for the next launch. */
  preference: GpuPreference;
  /** The preference this session was actually started with. */
  appliedPreference: GpuPreference;
  encoders: EncoderOption[];
}

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
  /**
   * Image embedded as the file's cover (MP4 / MOV), the thumbnail players and
   * Explorer show. Added after the encode by a stream-copy pass.
   */
  thumbnailPath?: string;
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
