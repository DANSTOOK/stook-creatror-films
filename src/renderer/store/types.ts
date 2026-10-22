import type {
  AudioBus,
  BackgroundRemovalConfig,
  Clip,
  MatteModelId,
  EqSettings,
  ExportSettings,
  Marker,
  MediaAsset,
  ProjectAudioState,
  ProjectState,
  Track,
  TrackType,
  Vector2D,
} from '@shared/types';
import {
  DEFAULT_DUCKING,
  DEFAULT_MARKER_COLOR,
  DEFAULT_PROJECT_AUDIO,
  MATTE_MODEL_IDS,
  NEUTRAL_EQ,
} from '@shared/types';
import { createId } from '@shared/utils/id';
import { BLEND_MODES, type BlendMode } from '@shared/types';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';
import { MAX_FRAME_RATE, MIN_FRAME_RATE } from '@shared/utils/frameRate';
import { tidyLinkGroups } from '@renderer/components/Timeline/linkGroups';
import { markerName, trackName } from '@renderer/i18n/defaultNames';
import { DEFAULT_PIVOT, neutralVignette, neutralWheel, normalizeGrading } from '@renderer/color/grade';
import { neutralCurves } from '@renderer/color/curves';
import { migrateTitleOrigin, normalizeTitle } from '@renderer/text/titleStyle';
import { normalizeTransitions, tidyTransitions, type TransitionPreset } from '@renderer/timing/transitions';
import { normalizeCaption, normalizeCaptionSettings } from '@renderer/captions/normalize';
import { normalizeGlossary } from '@renderer/captions/glossary';
import { normalizeEffects } from '@renderer/fx/effects/catalog';

/** What a project runs at when nothing better is known. */
const DEFAULT_FPS = 30;

/**
 * Serializable project document plus the editor-only UI state that must NOT be
 * written into the project file (selection, zoom, playback position of the
 * transport, and so on).
 */

/**
 * Bumped to 2 when the mixer and markers landed: tracks gained volume, pan,
 * solo and a bus, clips gained pan and EQ, and the project gained markers and
 * a master/ducking block. Version 1 files still open - `normalizeProject` fills
 * the new fields with the values that reproduce v1 behaviour exactly.
 */
export const PROJECT_FILE_VERSION = 2;

export interface ProjectDocument {
  version: number;
  savedAt: string;
  project: ProjectState;
  assets: MediaAsset[];
  /** Library bins. Absent in files saved before bins existed. */
  bins?: import('@shared/types').MediaBin[];
}

export type TimelineTool = 'select' | 'razor' | 'hand' | 'trim';

export interface EditorUiState {
  selectedClipIds: string[];
  selectedTrackId: string | null;
  tool: TimelineTool;
  /** Horizontal zoom of the timeline surface. */
  pixelsPerFrame: number;
  scrollLeftPx: number;
  snappingEnabled: boolean;
  /**
   * The magnet (point 9): deleting, moving or trimming a clip closes the gap
   * it leaves on its track, instead of leaving a hole in the edit.
   */
  rippleEnabled: boolean;
  isPlaying: boolean;
  loopPlayback: boolean;
  /** Nearest-neighbour scaling in the WebGL viewport. */
  pixelArtViewport: boolean;
  showTransparencyGrid: boolean;
  /**
   * The broadcast safe areas over the picture: action at 93% of the frame
   * and title at 90%. Off by default - they are a check, not scenery.
   */
  showSafeAreas: boolean;
  /**
   * The transform handles in the viewer.
   *
   * Off until asked for, as in Final Cut: a box drawn over the picture
   * whenever a clip happens to be selected is a box drawn over the picture
   * nearly always, and what the viewer is for is watching.
   */
  transformMode: boolean;
  /**
   * The viewer filling the window, for watching rather than editing.
   *
   * The same component, given the whole window: moving it somewhere else
   * in the tree would rebuild the WebGL context and every decoder with it.
   */
  fullscreenViewer: boolean;
  /**
   * The viewer shows the picture with every grade off (Resolve's bypass,
   * Shift+D). The viewer only: exports and the scopes keep the grade.
   */
  gradeBypass: boolean;
  /**
   * The before/after curtain, 0..1 across the frame, ungraded to its left;
   * null when it is not up. The viewer only, like the bypass.
   */
  compareSplit: number | null;
  /**
   * Width of the visible timeline area, measured by the Timeline. Kept here so
   * store actions can fit or reveal content without reaching into the DOM.
   */
  viewportWidthPx: number;
  /** Marker the ruler is highlighting, for rename and delete. */
  selectedMarkerId: string | null;
  /** First frame of the marked range (I), or null. */
  inFrame: number | null;
  /** One past its last frame (O), so out - in is a length. */
  outFrame: number | null;
  /** The library clip a three-point edit takes its source from. */
  selectedAssetId: string | null;
  /**
   * Playback speed and direction: 1 is ordinary play, 8 is L pressed three
   * times, -2 is running backwards. Only meaningful while playing.
   */
  playbackRate: number;
  /**
   * The title whose text is being typed into in the viewer, or null. While it
   * is, the viewer draws that title at rest - not mid-fade - under the text.
   */
  editingTitleId: string | null;
  /** The transition picked on the timeline, for the inspector and Delete. */
  selectedTransitionId: string | null;
  /**
   * Transitions asked for on cuts without enough footage: the question the
   * editor is being asked (overlap, freeze frames or cancel), or null.
   */
  pendingTransition: PendingTransition | null;
}

/** A request for transitions that is waiting on the editor's answer. */
export interface PendingTransition {
  preset: TransitionPreset;
  durationFrames: number;
  cuts: Array<{ fromId: string; toId: string }>;
  fades: Array<{ clipId: string; edge: 'in' | 'out' }>;
  /** The cuts that are short, and by how much on each side, in frames. */
  short: Array<{ fromName: string; toName: string; tail: number; head: number; shortTail: number; shortHead: number }>;
  /** How much shorter the overlap would make the edit. */
  overlapFrames: number;
  /** Clips on other tracks after the cut that the overlap would leave out of step. */
  leftBehind: string[];
}

export const DEFAULT_UI_STATE: EditorUiState = {
  selectedClipIds: [],
  selectedTrackId: null,
  tool: 'select',
  // About 25 s of a 30 fps timeline in a typical window, instead of 8 s. It
  // matters less than it did: the first clip added fits the view anyway.
  pixelsPerFrame: 2,
  scrollLeftPx: 0,
  snappingEnabled: true,
  rippleEnabled: true,
  isPlaying: false,
  loopPlayback: false,
  pixelArtViewport: false,
  showTransparencyGrid: true,
  showSafeAreas: false,
  transformMode: false,
  fullscreenViewer: false,
  gradeBypass: false,
  compareSplit: null,
  viewportWidthPx: 0,
  selectedMarkerId: null,
  inFrame: null,
  outFrame: null,
  selectedAssetId: null,
  playbackRate: 1,
  editingTitleId: null,
  selectedTransitionId: null,
  pendingTransition: null,
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'mp4-h264',
  outputPath: '',
  width: 1920,
  height: 1080,
  fps: 30,
  startFrame: 0,
  endFrame: 0,
  exportAlpha: false,
  premultiplyAlpha: false,
  pixelArtScaling: false,
  // Derived from the project size rather than fixed; see recommendedBitrateKbps.
  bitrateKbps: recommendedBitrateKbps(1920, 1080, 30),
  // Resolved per render by resolveEncoderPlan.
  hardwareEncoder: 'auto',
  // Replaced at export time when the platform offers a usable GPU encoder.
  pipeMode: 'rawvideo',
};

/* -------------------------------------------------------------------------- */
/* Factories                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which bus a track feeds by default.
 *
 * Name sniffing used to happen at playback time, on every scheduled clip. It
 * happens once, here, so the routing is visible in the mixer and editable -
 * and renaming a track no longer re-routes it behind the user's back.
 *
 * A name that says what it is wins. Otherwise a picture track is dialogue -
 * a camera's sound is mostly people talking, and Final Cut gives the audio
 * of video clips the Dialogue role for the same reason - and a sound track
 * is music. Every track used to default to music, so switching auto ducking
 * on in a project of camera footage and a song ducked nothing against
 * nothing. The bus only matters to ducking: with it off, both buses are the
 * same straight path to the master.
 */
export function defaultBusForName(name: string, type: TrackType = 'audio'): AudioBus {
  if (/dialog|dialogue|di[aá]logo|voice|voix|voz|vo\b|narrat/i.test(name)) return 'dialogue';
  if (/music|m[uú]sica|score|song|canci[oó]n|bgm/i.test(name)) return 'music';
  return type === 'audio' ? 'music' : 'dialogue';
}

export function createTrack(type: TrackType, order: number, name?: string): Track {
  const resolved = name ?? trackName(type, order + 1);
  return {
    id: createId('track'),
    name: resolved,
    type,
    muted: false,
    locked: false,
    visible: true,
    order,
    volume: 1,
    pan: 0,
    solo: false,
    bus: defaultBusForName(resolved, type),
  };
}

export function createMarker(frame: number, label?: string, color?: string): Marker {
  const rounded = Math.max(0, Math.round(frame));
  return {
    id: createId('marker'),
    frame: rounded,
    label: label ?? markerName(rounded),
    color: color ?? DEFAULT_MARKER_COLOR,
  };
}

export interface CreateClipInput {
  trackId: string;
  name: string;
  sourceUri: string;
  startFrame: number;
  durationFrames: number;
  sourceOffsetFrames?: number;
  hasAlphaChannel?: boolean;
  /** Starting size, e.g. to fit a picture whole inside a frame of another shape. */
  initialScale?: Vector2D;
}

export function createClip(input: CreateClipInput): Clip {
  return {
    id: createId('clip'),
    trackId: input.trackId,
    name: input.name,
    sourceUri: input.sourceUri,
    startFrame: Math.max(0, Math.round(input.startFrame)),
    durationFrames: Math.max(1, Math.round(input.durationFrames)),
    sourceOffsetFrames: input.sourceOffsetFrames ?? 0,
    hasAlphaChannel: input.hasAlphaChannel ?? false,
    transform: {
      position: [],
      // One keyframe is a fixed value, not an animation.
      scale: input.initialScale
        ? [{ id: createId('kf'), frame: Math.max(0, Math.round(input.startFrame)), value: { ...input.initialScale }, easing: 'linear' }]
        : [],
      rotation: [],
      opacity: [],
      anchorPoint: { x: 0.5, y: 0.5 },
    },
    mask: {
      enabled: false,
      type: 0,
      center: { x: 0.5, y: 0.5 },
      size: { x: 0.5, y: 0.5 },
      rotation: 0,
      cornerRadius: 0,
      feather: 2,
      invert: false,
    },
    colorGrading: {
      enabled: false,
      exposure: 0,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      lutIntensity: 1,
      pivot: DEFAULT_PIVOT,
      lift: neutralWheel(),
      gamma: neutralWheel(),
      gain: neutralWheel(),
      offset: neutralWheel(),
      curves: neutralCurves(),
      vignette: neutralVignette(),
    },
    chromaKey: {
      enabled: false,
      keyColor: [0.06, 0.63, 0.15],
      similarity: 0.4,
      smoothness: 0.1,
      spill: 0.3,
    },
    backgroundRemoval: { enabled: false, model: 'precise', invert: false },
    pixelArt: {
      enabled: false,
      pixelSize: 4,
      paletteSteps: 0,
      alphaThreshold: 0.5,
    },
    volume: 1,
    pan: 0,
    eq: { ...NEUTRAL_EQ },
  };
}

export function createEmptyProject(
  width = 1920,
  height = 1080,
  fps: ProjectState['fps'] = 30,
): ProjectState {
  const tracks = [
    createTrack('video', 0, trackName('video', 1)),
    createTrack('video', 1, trackName('video', 2)),
    createTrack('audio', 2, trackName('audio', 1)),
  ];

  return {
    fps,
    width,
    height,
    durationFrames: fps * 60,
    currentFrame: 0,
    tracks,
    clips: {},
    hasAlphaBackground: false,
    markers: [],
    audio: { ...DEFAULT_PROJECT_AUDIO, ducking: { ...DEFAULT_PROJECT_AUDIO.ducking } },
  };
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */

/** A blend mode this build knows; anything else opens as normal rather than refusing to draw. */
const isBlendMode = (value: unknown): value is BlendMode =>
  typeof value === 'string' && (BLEND_MODES as readonly string[]).includes(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Remove background as read from a file. A project from before it existed
 * has none and opens with it off; a model this build does not know - a file
 * from a later version, say - falls back to the precise one rather than
 * leaving a clip that cannot be analysed. A project from before Invert
 * existed keeps the subject, as it did then.
 */
export function normalizeBackgroundRemoval(value: unknown): BackgroundRemovalConfig {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<BackgroundRemovalConfig>;
  return {
    enabled: source.enabled === true,
    model: (MATTE_MODEL_IDS as readonly unknown[]).includes(source.model) ? (source.model as MatteModelId) : 'precise',
    invert: source.invert === true,
  };
}

function normalizeEq(eq: unknown): EqSettings {
  const source = (eq ?? {}) as Partial<EqSettings>;
  return {
    low: finite(source.low, 0),
    mid: finite(source.mid, 0),
    high: finite(source.high, 0),
  };
}

function normalizeAudio(audio: unknown): ProjectAudioState {
  const source = (audio ?? {}) as Partial<ProjectAudioState>;
  const ducking = (source.ducking ?? {}) as Partial<ProjectAudioState['ducking']>;

  return {
    masterVolume: finite(source.masterVolume, 1),
    ducking: {
      enabled: ducking.enabled === true,
      thresholdDb: finite(ducking.thresholdDb, DEFAULT_DUCKING.thresholdDb),
      rangeDb: finite(ducking.rangeDb, DEFAULT_DUCKING.rangeDb),
      attackSeconds: finite(ducking.attackSeconds, DEFAULT_DUCKING.attackSeconds),
      releaseSeconds: finite(ducking.releaseSeconds, DEFAULT_DUCKING.releaseSeconds),
    },
  };
}

/**
 * Fill in everything a project saved by an older build has no field for.
 *
 * The defaults are chosen to reproduce the old behaviour rather than to be
 * tidy: unity gain, centre pan, nothing soloed, ducking off, and the bus
 * derived from the track name - which is exactly what version 1 did at
 * playback time. Reopening a v1 project must sound identical to how it sounded
 * when it was saved, or the mixer has quietly re-mixed somebody's edit.
 */
/** A clip's effects as read from a file, or undefined for none (fx/effects/catalog). */
function normalizedEffectsOrNone(raw: unknown): Clip['effects'] {
  const effects = normalizeEffects(raw);
  return effects.length > 0 ? effects : undefined;
}

export function normalizeProject(project: ProjectState): ProjectState {
  return withGlossary(withParkedCaptions(withTransitions(normalizeClipsAndTracks(project), project.transitions), project.parkedCaptions), project.glossary);
}

/** The glossary read from a file (captions/glossary.ts): tidied; none, no field. */
function withGlossary(project: ProjectState, raw: unknown): ProjectState {
  const { glossary: _dropped, ...rest } = project;
  void _dropped;
  const glossary = normalizeGlossary(raw);
  return glossary.length > 0 ? { ...rest, glossary } : rest;
}

/**
 * Captions kept out of the edit (captions/follow.ts), read from a file: only
 * captions, only for a captions track the project still has, and never one
 * that is also on the timeline. A project with none carries no field.
 */
function withParkedCaptions(project: ProjectState, raw: unknown): ProjectState {
  const { parkedCaptions: _dropped, ...rest } = project;
  void _dropped;
  if (!raw || typeof raw !== 'object') return rest;
  const tracks = new Set(rest.tracks.filter((track) => track.type === 'captions').map((track) => track.id));
  const parked: Record<string, Clip> = {};
  for (const [id, clip] of Object.entries(raw as Record<string, Clip>)) {
    if (!clip || typeof clip !== 'object' || !clip.caption || !tracks.has(clip.trackId) || rest.clips[id]) continue;
    parked[id] = { ...clip, id, caption: normalizeCaption(clip.caption) };
  }
  return Object.keys(parked).length > 0 ? { ...rest, parkedCaptions: parked } : rest;
}

/**
 * Transitions read from a file, kept only where their cut still is. A project
 * with none carries no field at all, as projects from before transitions do.
 */
function withTransitions(project: ProjectState, raw: unknown): ProjectState {
  const { transitions: _dropped, ...rest } = project;
  void _dropped;
  const transitions = normalizeTransitions(raw);
  if (Object.keys(transitions).length === 0) return rest;
  const tidy = tidyTransitions({ ...rest, transitions });
  return Object.keys(tidy.transitions ?? {}).length > 0 ? tidy : rest;
}

/** A clip's chosen move and animations (Clip.fx), or nothing if there is nothing readable. */
function normalizeClipFx(fx: unknown): Clip['fx'] {
  if (!fx || typeof fx !== 'object') return undefined;
  const source = fx as Record<string, unknown>;
  const out: NonNullable<Clip['fx']> = {};
  const unit = (value: unknown): number => Math.min(1, Math.max(0, finite(value, 0.5)));
  const motion = source.motion as Record<string, unknown> | undefined;
  if (motion && typeof motion.preset === 'string') {
    const focus = (motion.focus ?? {}) as Record<string, unknown>;
    out.motion = { preset: motion.preset, amount: Math.min(10, Math.max(0.25, finite(motion.amount, 1))), focus: { x: unit(focus.x), y: unit(focus.y) } };
  }
  for (const phase of ['in', 'out'] as const) {
    const chosen = source[phase] as Record<string, unknown> | undefined;
    if (chosen && typeof chosen.id === 'string') out[phase] = { id: chosen.id, seconds: Math.min(3, Math.max(0.2, finite(chosen.seconds, 0.6))) };
  }
  const loop = source.loop as Record<string, unknown> | undefined;
  if (loop && typeof loop.id === 'string') out.loop = { id: loop.id };
  if (!(out.motion || out.in || out.out || out.loop)) return undefined;
  // The transform from before any of it, kept when it is a transform at all.
  const base = source.base as Record<string, unknown> | undefined;
  const tracks = ['position', 'scale', 'rotation', 'opacity'] as const;
  if (base && typeof base === 'object' && tracks.every((track) => Array.isArray(base[track])) && base.anchorPoint && typeof base.anchorPoint === 'object') {
    out.base = base as unknown as NonNullable<Clip['fx']>['base'];
  }
  return out;
}

/** What a followed clip had before it followed, kept only when it reads as keyframes. */
function normalizeTracking(tracking: unknown): Clip['tracking'] {
  if (!tracking || typeof tracking !== 'object') return undefined;
  const source = tracking as Record<string, unknown>;
  if (!Array.isArray(source.before) || typeof source.fromFrame !== 'number' || !Number.isFinite(source.fromFrame)) return undefined;
  return {
    fromFrame: Math.max(0, Math.round(source.fromFrame)),
    before: source.before as NonNullable<Clip['tracking']>['before'],
    ...(Array.isArray(source.beforeScale) ? { beforeScale: source.beforeScale as NonNullable<Clip['tracking']>['before'] } : {}),
  };
}

function normalizeClipsAndTracks(project: ProjectState): ProjectState {
  const markers = (Array.isArray(project.markers) ? project.markers : [])
    .map((marker, index) => ({
      id: marker?.id ?? createId('marker'),
      frame: Math.max(0, Math.round(finite(marker?.frame, 0))),
      label: marker?.label ?? markerName(index + 1),
      color: marker?.color ?? DEFAULT_MARKER_COLOR,
    }))
    .sort((a, b) => a.frame - b.frame);

  /**
   * A rate outside the believable range means the project was built before
   * imports were bounded, when a bad measurement could be adopted whole. Such
   * a project counts its own length in millions of frames, so it is repaired
   * on the way in rather than opened unusable.
   */
  const fps = finite(project.fps, DEFAULT_FPS);
  const sane = fps >= MIN_FRAME_RATE && fps <= MAX_FRAME_RATE;
  const seconds = sane ? 0 : Math.round(finite(project.durationFrames, 0) / fps);

  return {
    ...project,
    ...(sane
      ? {}
      : {
          fps: DEFAULT_FPS,
          // Keep the wall-clock length it had, at a rate that can exist.
          durationFrames: Math.max(DEFAULT_FPS, Math.round(seconds * DEFAULT_FPS)),
        }),
    markers,
    audio: normalizeAudio(project.audio),
    tracks: project.tracks.map((track) => ({
      ...track,
      volume: finite(track.volume, 1),
      pan: finite(track.pan, 0),
      solo: track.solo === true,
      // A project from before buses were saved routes as version 1 did, by
      // name alone, so an old mix sounds the same.
      bus: track.bus === 'dialogue' || track.bus === 'music' ? track.bus : defaultBusForName(track.name),
      ...(track.type === 'captions' ? { captions: normalizeCaptionSettings(track.captions) } : {}),
    })),
    // A link group whose other members are gone means nothing, and a clip that
    // says it is linked but moves alone is worse than one that never said it.
    clips: tidyLinkGroups(
      Object.fromEntries(
        Object.entries(project.clips).map(([id, clip]) => [
          id,
          // A title from before origins keeps drawing as it did (text/titleStyle).
          migrateTitleOrigin({
            ...clip,
            volume: finite(clip.volume, 1),
            pan: finite(clip.pan, 0),
            eq: normalizeEq(clip.eq),
            // Written plainly, not spread in: a mode this build does not know
            // has to be cleared, not merely left unset.
            blendMode: isBlendMode(clip.blendMode) && clip.blendMode !== 'normal' ? clip.blendMode : undefined,
            // A grade saved before the wheels opens with them neutral, so it
            // looks exactly as it did.
            colorGrading: normalizeGrading(clip.colorGrading),
            backgroundRemoval: normalizeBackgroundRemoval(clip.backgroundRemoval),
            // The effect stack: written plainly, so a clip with none carries
            // no field, and an effect from a later version is dropped.
            effects: normalizedEffectsOrNone(clip.effects),
            // The move and animations as chosen: kept only in a shape this build can read.
            fx: normalizeClipFx(clip.fx),
            tracking: normalizeTracking(clip.tracking),
            // A title with a setting missing or out of range still draws.
            ...(clip.title ? { title: normalizeTitle(clip.title) } : {}),
            ...(clip.caption ? { caption: normalizeCaption(clip.caption) } : {}),
          }),
        ]),
      ),
    ),
  };
}
