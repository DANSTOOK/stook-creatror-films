import type {
  AudioBus,
  Clip,
  EqSettings,
  ExportSettings,
  Marker,
  MediaAsset,
  ProjectAudioState,
  ProjectState,
  Track,
  TrackType,
} from '@shared/types';
import {
  DEFAULT_DUCKING,
  DEFAULT_MARKER_COLOR,
  DEFAULT_PROJECT_AUDIO,
  NEUTRAL_EQ,
} from '@shared/types';
import { createId } from '@shared/utils/id';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';

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
}

export type TimelineTool = 'select' | 'razor' | 'hand';

export interface EditorUiState {
  selectedClipIds: string[];
  selectedTrackId: string | null;
  tool: TimelineTool;
  /** Horizontal zoom of the timeline surface. */
  pixelsPerFrame: number;
  scrollLeftPx: number;
  snappingEnabled: boolean;
  isPlaying: boolean;
  loopPlayback: boolean;
  /** Nearest-neighbour scaling in the WebGL viewport. */
  pixelArtViewport: boolean;
  showTransparencyGrid: boolean;
  /**
   * Width of the visible timeline area, measured by the Timeline. Kept here so
   * store actions can fit or reveal content without reaching into the DOM.
   */
  viewportWidthPx: number;
  /** Marker the ruler is highlighting, for rename and delete. */
  selectedMarkerId: string | null;
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
  isPlaying: false,
  loopPlayback: false,
  pixelArtViewport: false,
  showTransparencyGrid: true,
  viewportWidthPx: 0,
  selectedMarkerId: null,
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
 */
export function defaultBusForName(name: string): AudioBus {
  return /dialog|dialogue|voice|voix|voz|vo\b|narrat/i.test(name) ? 'dialogue' : 'music';
}

export function createTrack(type: TrackType, order: number, name?: string): Track {
  const resolved = name ?? `${type[0].toUpperCase()}${type.slice(1)} ${order + 1}`;
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
    bus: defaultBusForName(resolved),
  };
}

export function createMarker(frame: number, label?: string, color?: string): Marker {
  const rounded = Math.max(0, Math.round(frame));
  return {
    id: createId('marker'),
    frame: rounded,
    label: label ?? `Marker ${rounded}`,
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
      scale: [],
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
    },
    chromaKey: {
      enabled: false,
      keyColor: [0.06, 0.63, 0.15],
      similarity: 0.4,
      smoothness: 0.1,
      spill: 0.3,
    },
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
    createTrack('video', 0, 'Video 1'),
    createTrack('video', 1, 'Video 2'),
    createTrack('audio', 2, 'Audio 1'),
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

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

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
export function normalizeProject(project: ProjectState): ProjectState {
  const markers = (Array.isArray(project.markers) ? project.markers : [])
    .map((marker, index) => ({
      id: marker?.id ?? createId('marker'),
      frame: Math.max(0, Math.round(finite(marker?.frame, 0))),
      label: marker?.label ?? `Marker ${index + 1}`,
      color: marker?.color ?? DEFAULT_MARKER_COLOR,
    }))
    .sort((a, b) => a.frame - b.frame);

  return {
    ...project,
    markers,
    audio: normalizeAudio(project.audio),
    tracks: project.tracks.map((track) => ({
      ...track,
      volume: finite(track.volume, 1),
      pan: finite(track.pan, 0),
      solo: track.solo === true,
      bus: track.bus === 'dialogue' || track.bus === 'music' ? track.bus : defaultBusForName(track.name),
    })),
    clips: Object.fromEntries(
      Object.entries(project.clips).map(([id, clip]) => [
        id,
        { ...clip, volume: finite(clip.volume, 1), pan: finite(clip.pan, 0), eq: normalizeEq(clip.eq) },
      ]),
    ),
  };
}
