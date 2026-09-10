import type {
  Clip,
  ExportSettings,
  MediaAsset,
  ProjectState,
  Track,
  TrackType,
} from '@shared/types';
import { createId } from '@shared/utils/id';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';

/**
 * Serializable project document plus the editor-only UI state that must NOT be
 * written into the project file (selection, zoom, playback position of the
 * transport, and so on).
 */

export const PROJECT_FILE_VERSION = 1;

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
  markers: number[];
}

export const DEFAULT_UI_STATE: EditorUiState = {
  selectedClipIds: [],
  selectedTrackId: null,
  tool: 'select',
  pixelsPerFrame: 6,
  scrollLeftPx: 0,
  snappingEnabled: true,
  isPlaying: false,
  loopPlayback: false,
  pixelArtViewport: false,
  showTransparencyGrid: true,
  markers: [],
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
  hardwareEncoder: 'none',
  // Replaced at export time when the platform offers a usable GPU encoder.
  pipeMode: 'rawvideo',
};

/* -------------------------------------------------------------------------- */
/* Factories                                                                  */
/* -------------------------------------------------------------------------- */

export function createTrack(type: TrackType, order: number, name?: string): Track {
  return {
    id: createId('track'),
    name: name ?? `${type[0].toUpperCase()}${type.slice(1)} ${order + 1}`,
    type,
    muted: false,
    locked: false,
    visible: true,
    order,
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
  };
}
