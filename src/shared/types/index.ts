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

/** A point on a grading curve: input across, output (or offset) up. */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * The curves of a grade (colour phase 3). Units and interpolation in
 * src/renderer/color/curves.ts. Projects saved before them open neutral.
 */
export interface GradeCurves {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
  hueVsHue: CurvePoint[];
  hueVsSat: CurvePoint[];
  hueVsLuma: CurvePoint[];
  lumaVsSat: CurvePoint[];
}

/** A vignette centred on the frame. `amount` 0 is none. */
export interface VignetteConfig {
  /** -1 darkens the edges to black, +1 lightens them to white. */
  amount: number;
  /** Where the darkening begins, 0 (the centre) to 1 (past the corners). */
  size: number;
  /** -1 squarish, 0 the frame's own shape, +1 a circle. */
  roundness: number;
  /** How soft the edge is, 0 hard to 1 very soft. */
  feather: number;
}

export interface ColorGradingConfig {
  enabled: boolean;
  exposure: number; // -2.0 to 2.0
  contrast: number; // 0.0 to 2.0
  saturation: number; // 0.0 to 2.0
  temperature: number; // -1.0 to 1.0
  tint: number; // -1.0 to 1.0
  /**
   * The level contrast turns about, 0-1 on the encoded picture. 0.5, the
   * fixed pivot before it could be moved.
   */
  pivot: number;
  /**
   * The primaries wheels - lift, gamma, gain, offset - as R, G, B each, 0
   * neutral, -1..1. Carried to the GPU as one ASC CDL; the units are in
   * src/renderer/color/grade.ts. Projects saved before them open neutral.
   */
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  offset: [number, number, number];
  curves: GradeCurves;
  vignette: VignetteConfig;
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

/* -------------------------------------------------------------------------- */
/* Titles                                                                     */
/* -------------------------------------------------------------------------- */

/** The three templates a title starts from. */
export type TitlePreset = 'title' | 'lowerThird' | 'credits';

export type TitleAlign = 'left' | 'center' | 'right';

/** Which point of the title-safe area the block of text is pinned to. */
export type TitleAnchor =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'left'
  | 'center'
  | 'right'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight';

/**
 * How a title looks. Every length is in pixels of a 1080-line frame, so a
 * title keeps its composition when the project changes resolution: on a 4K
 * project the renderer doubles them. Colours are sRGB `#rrggbb`.
 */
export interface TitleStyle {
  fontFamily: string;
  /** 100 (thin) to 900 (black). */
  fontWeight: number;
  fontSize: number;
  color: string;
  align: TitleAlign;
  /** Distance from one baseline to the next, as a multiple of the size. */
  lineHeight: number;
  /** Extra space between letters, in percent of the size. */
  letterSpacing: number;
  /**
   * Size of every line after the first, as a share of the first: a lower
   * third's role under the name. 1 keeps them all the same.
   */
  secondaryScale: number;
  /** Longest a line may be before it wraps, as a share of the title-safe width. */
  maxWidth: number;
  anchor: TitleAnchor;
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; opacity: number; distance: number; angle: number; blur: number };
  box: { enabled: boolean; color: string; opacity: number; padding: number; radius: number };
}

/** How a title comes on. */
export type TitleEntrance = 'none' | 'fade' | 'rise' | 'pop' | 'wipe';
/** How it goes off: shorter than coming on, and never with a bounce. */
export type TitleExit = 'none' | 'fade' | 'drop' | 'vanish';

/**
 * A title's own animation, worked out per frame by the compositor (see
 * renderer/text/animation.ts). It rides on top of the clip's keyframes -
 * opacity and scale multiply, movement adds - and is counted from the clip's
 * ends, so trimming the clip keeps the exit at the end.
 */
export interface TitleAnimation {
  in: TitleEntrance;
  inSeconds: number;
  out: TitleExit;
  outSeconds: number;
  /**
   * End credits: the text rolls up through the frame at one speed over the
   * whole clip, from just below it to just above it. The entrance and exit
   * are not used while it rolls.
   */
  roll: boolean;
}

/**
 * What a title scales and turns about. `text`: the centre of its text (and
 * box). `frame`: the centre of the frame, which is how titles made before
 * this choice existed were drawn; a saved title keeps it only where moving
 * to the text's centre would change the picture (see normalizeProject).
 */
export type TitleOrigin = 'text' | 'frame';

/**
 * What makes a clip a title: generated text instead of a file. A title clip
 * has no media asset; its `sourceUri` only names it (see isTitleUri).
 */
export interface TitleContent {
  preset: TitlePreset;
  text: string;
  style: TitleStyle;
  /** Absent on titles made before animations: none. */
  animation?: TitleAnimation;
  /** Absent on titles made before it existed: see TitleOrigin. */
  origin?: TitleOrigin;
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
  /** Stereo position, -1 hard left to +1 hard right. */
  pan: number;
  /** Per-clip corrective EQ, applied before the track strip. */
  eq: EqSettings;
  /**
   * Playback speed, 1 being the footage's own. Absent on clips saved before
   * retiming existed, which means the same thing.
   */
  speed?: number;
  /** Play the footage backwards. The picture only; see audioFollowsSpeed. */
  reversed?: boolean;
  /**
   * Frames of fade at each end, taking the picture and the sound together.
   *
   * Absent means none, which is what every clip made before fades existed
   * meant. See renderer/timing/clipFades.
   */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /**
   * Derived for the sound only, never saved: an equal-power crossfade at
   * this end, in frames, where a transition's crossfade takes the place of
   * the fade (see timing/transitions withAudioCrossfades).
   */
  crossfadeInFrames?: number;
  crossfadeOutFrames?: number;
  /**
   * Clips sharing this id are linked: selecting one selects them all, so
   * they move, trim and are deleted as one. Absent on a clip that stands
   * alone, which is nearly all of them.
   */
  linkGroup?: string;
  /**
   * Present on a title: the text and how it looks. Absent on every clip that
   * comes from a file, which is every clip made before titles existed.
   */
  title?: TitleContent;
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

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A cross dissolve; a dip through a colour (black, white, any); a wipe (an
 * edge crossing the picture); a slide (the incoming picture moving in over
 * the outgoing one); or a push (the incoming picture pushing the outgoing
 * one out).
 */
export type TransitionKind = 'crossDissolve' | 'dip' | 'wipe' | 'slide' | 'push';

/** Which way a wipe's edge, a slide or a push travels across the frame. */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Where a transition sits on its cut: across it (half each side), all after
 * it (starts at the cut: the outgoing clip runs on), or all before it (ends
 * at the cut: the incoming clip starts early). Premiere's Center at Cut,
 * Start at Cut and End at Cut.
 */
export type TransitionAlignment = 'center' | 'start' | 'end';

/**
 * A transition, on the cut between two clips that touch on one track.
 *
 * The clips themselves never overlap: the outgoing clip is drawn past its
 * end and the incoming one before its start, from the footage beyond them
 * (their handles) - or holding their last and first frames where there is
 * none, if the editor chose that. See renderer/timing/transitions.ts.
 */
export interface Transition {
  id: string;
  /** The clip that ends at the cut. */
  fromClipId: string;
  /** The clip that starts at it. */
  toClipId: string;
  kind: TransitionKind;
  durationFrames: number;
  alignment: TransitionAlignment;
  /** A dip's colour, sRGB `#rrggbb`. */
  color: string;
  /** Which way a wipe, slide or push travels. */
  direction: TransitionDirection;
  /** A wipe's edge: 0 hard, 1 as soft as a fifth of the frame. */
  softness: number;
  /**
   * The sound crossfades with the picture, as Final Cut does: the two clips'
   * own sound, and their linked sound clips that meet at the same cut, at
   * equal power. On unless switched off in the inspector.
   */
  audioCrossfade: boolean;
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
  /**
   * Transitions, by id, each on a cut between two touching clips. Absent in
   * projects saved before transitions existed, which means none.
   */
  transitions?: Record<string, Transition>;
}

/* -------------------------------------------------------------------------- */
/* Media library                                                              */
/* -------------------------------------------------------------------------- */

export type MediaKind = 'video' | 'audio' | 'image';

/**
 * A folder in the media library - a "bin", as DaVinci Resolve calls it.
 *
 * Bins organise what is already in the project; nothing on disk moves. The
 * top level ("Master") is not a bin: it is where anything without one sits.
 */
export interface MediaBin {
  id: string;
  name: string;
  /** The containing bin, or null for the top level. */
  parentId: string | null;
}

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
  /**
   * Length in frames at the rate the project had when this was imported.
   * Kept for older projects; use `assetLengthFrames`, which prefers
   * `durationSeconds` and so stays right after a frame rate change.
   */
  durationFrames: number;
  /** The file's own length in seconds, as measured on import. */
  durationSeconds?: number;
  width: number;
  height: number;
  hasAlphaChannel: boolean;
  /** Frame rate of the source material, when it could be determined. */
  sourceFps?: number;
  /** Data URL of a poster frame, when one has been decoded. */
  thumbnailUri?: string;
  /**
   * A small stand-in used by the preview only, when proxies are on.
   *
   * The export reads the original file, always: a proxy is a way to edit
   * heavy footage, never a thing to deliver.
   */
  proxyUri?: string;
  /**
   * The audio track alone, extracted by ffmpeg, for decoding. Decoding needs
   * the whole encoded file in memory, and for a long video the whole file is
   * gigabytes of pictures; this is megabytes. Session-only, like `uri`.
   */
  audioUri?: string;
  /** Set when a reopened project could not restore this asset from disk. */
  missing?: boolean;
  /** The library bin this asset is filed in; absent means the top level. */
  binId?: string;
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

/** The YUV matrix and range an encoder used, as measured. */
export interface StreamColour {
  matrix: 'bt709' | 'bt601';
  fullRange: boolean;
}

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
   * How the WebCodecs encoder converted RGB to YUV, measured before the
   * render (measureStreamColour), so the muxer can tag the stream to match.
   * Absent on the raw pipe, where ffmpeg converts with BT.709 itself.
   */
  streamColour?: StreamColour;
  /**
   * Temporary WAV holding the rendered audio mix, muxed as a second input.
   * Absent for a silent timeline or a format that carries no audio.
   */
  audioPath?: string;
  audioBitrateKbps?: number;
  /**
   * Set when `audioPath` is a streamed mix: headerless interleaved float32
   * at this rate and channel count, rather than a WAV. It has no size limit,
   * which a WAV's 4 GB header does - about three hours of stereo float.
   */
  audioRawFormat?: { sampleRate: number; channels: number };
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
