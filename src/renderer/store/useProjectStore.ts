import { create } from 'zustand';
import type {
  Clip,
  ExportSettings,
  Keyframe,
  MediaAsset,
  ProjectState,
  Track,
  TrackType,
  Vector2D,
} from '@shared/types';
import { createId } from '@shared/utils/id';
import { clamp } from '@shared/utils/math';
import {
  clipAtFrame,
  clipEndFrame,
  moveClip,
  projectContentLength,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from '@renderer/components/Timeline/timelineOps';
import { collectSnapTargets, snapClipMove, snapFrame } from '@renderer/components/Timeline/snapping';
import { settingsFromAsset } from '@renderer/media/importMedia';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';
import { createSnapshotCommand, useHistoryStore } from './useHistoryStore';
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_UI_STATE,
  PROJECT_FILE_VERSION,
  createClip,
  createEmptyProject,
  createTrack,
  type CreateClipInput,
  type EditorUiState,
  type ProjectDocument,
  type TimelineTool,
} from './types';

/**
 * Single source of truth for the editor.
 *
 * Every mutation that belongs in the undo history goes through `transact`,
 * which computes the next project, pushes a command and commits - so no caller
 * can accidentally produce an un-undoable edit.
 */

export type VectorProperty = 'position' | 'scale';
export type NumberProperty = 'rotation' | 'opacity';

interface ProjectStore {
  project: ProjectState;
  assets: MediaAsset[];
  ui: EditorUiState;
  exportSettings: ExportSettings;
  /** Name of the clip whose settings the project adopted, for the UI to report. */
  adoptedSettingsFrom: string | null;

  /* Document ------------------------------------------------------------- */
  newProject(width?: number, height?: number, fps?: ProjectState['fps']): void;
  loadDocument(document: ProjectDocument): void;
  toDocument(): ProjectDocument;

  /* History -------------------------------------------------------------- */
  transact(label: string, mutate: (project: ProjectState) => ProjectState, mergeKey?: string): void;
  undo(): void;
  redo(): void;

  /* Transport ------------------------------------------------------------ */
  setCurrentFrame(frame: number): void;
  stepFrames(delta: number): void;
  setPlaying(playing: boolean): void;
  setProjectSettings(settings: Partial<Pick<ProjectState, 'fps' | 'width' | 'height' | 'durationFrames' | 'hasAlphaBackground'>>): void;

  /* UI ------------------------------------------------------------------- */
  setUi(patch: Partial<EditorUiState>): void;
  setTool(tool: TimelineTool): void;
  selectClips(clipIds: string[], additive?: boolean): void;
  zoomBy(factor: number): void;

  /* Tracks --------------------------------------------------------------- */
  addTrack(type: TrackType, name?: string): void;
  /** Insert a track at a specific position, for "add above / add below". */
  addTrackAt(type: TrackType, order: number, name?: string): void;
  updateTrack(trackId: string, patch: Partial<Track>): void;
  removeTrack(trackId: string): void;
  /** Move a track up (-1) or down (+1) in the stacking order. */
  moveTrack(trackId: string, delta: number): void;

  /* Clips ---------------------------------------------------------------- */
  addClip(input: CreateClipInput): string;
  addAssetToTimeline(asset: MediaAsset, trackId: string, startFrame: number): string;
  updateClip(clipId: string, patch: Partial<Clip>, mergeKey?: string): void;
  removeClips(clipIds: string[]): void;
  /** Copy a clip and drop the copy immediately after the original. */
  duplicateClips(clipIds: string[]): void;
  moveClipTo(clipId: string, trackId: string, startFrame: number): void;
  trimClip(clipId: string, edge: 'start' | 'end', frame: number): void;
  /** Razor tool: split at the playhead. */
  razorAtFrame(frame?: number, clipIds?: string[]): void;

  /* Keyframes ------------------------------------------------------------ */
  setVectorKeyframe(clipId: string, property: VectorProperty, frame: number, value: Vector2D): void;
  setNumberKeyframe(clipId: string, property: NumberProperty, frame: number, value: number): void;
  removeKeyframe(clipId: string, property: VectorProperty | NumberProperty, keyframeId: string): void;
  clearKeyframes(clipId: string, property: VectorProperty | NumberProperty): void;

  /* Media ---------------------------------------------------------------- */
  addAssets(assets: MediaAsset[]): void;
  removeAsset(assetId: string): void;

  /* Export --------------------------------------------------------------- */
  setExportSettings(patch: Partial<ExportSettings>): void;
}

/** Reassign contiguous order values after an insert, move or delete. */
const renumber = (tracks: Track[]): Track[] =>
  tracks.map((track, index) => ({ ...track, order: index }));

/** Keep `durationFrames` at least as long as the content plus a little tail. */
function withContentLength(project: ProjectState): ProjectState {
  const content = projectContentLength(project);
  if (content <= project.durationFrames) return project;
  return { ...project, durationFrames: content + project.fps };
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: createEmptyProject(),
  assets: [],
  ui: { ...DEFAULT_UI_STATE },
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  adoptedSettingsFrom: null,

  /* Document ------------------------------------------------------------- */

  newProject(width = 1920, height = 1080, fps = 30) {
    useHistoryStore.getState().clear();
    set({
      project: createEmptyProject(width, height, fps),
      assets: [],
      ui: { ...DEFAULT_UI_STATE },
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, width, height, fps },
    });
  },

  loadDocument(document) {
    if (document.version > PROJECT_FILE_VERSION) {
      throw new Error(
        `Project was saved by a newer version (file v${document.version}, app v${PROJECT_FILE_VERSION})`,
      );
    }
    useHistoryStore.getState().clear();
    set({
      project: document.project,
      assets: document.assets,
      ui: { ...DEFAULT_UI_STATE },
      exportSettings: {
        ...DEFAULT_EXPORT_SETTINGS,
        width: document.project.width,
        height: document.project.height,
        fps: document.project.fps,
        endFrame: document.project.durationFrames,
      },
    });
  },

  toDocument() {
    const { project, assets } = get();
    return {
      version: PROJECT_FILE_VERSION,
      savedAt: new Date().toISOString(),
      project,
      // Blob URLs die with the page, so persisting one would guarantee a broken
      // project on reopen. Only `sourcePath` survives; the URL is rebuilt then.
      assets: assets.map((asset) => ({ ...asset, uri: '' })),
    };
  },

  /* History -------------------------------------------------------------- */

  transact(label, mutate, mergeKey) {
    const before = get().project;
    const after = withContentLength(mutate(before));
    if (after === before) return;

    useHistoryStore.getState().push(createSnapshotCommand(label, before, after, mergeKey));
    set({ project: after });
  },

  undo() {
    const reverted = useHistoryStore.getState().undo(get().project);
    if (reverted) set({ project: reverted, ui: { ...get().ui, selectedClipIds: [] } });
  },

  redo() {
    const reapplied = useHistoryStore.getState().redo(get().project);
    if (reapplied) set({ project: reapplied, ui: { ...get().ui, selectedClipIds: [] } });
  },

  /* Transport ------------------------------------------------------------ */

  setCurrentFrame(frame) {
    const { project } = get();
    const clamped = clamp(Math.round(frame), 0, project.durationFrames);
    if (clamped === project.currentFrame) return;
    // Scrubbing is not an undoable edit.
    set({ project: { ...project, currentFrame: clamped } });
  },

  stepFrames(delta) {
    get().setCurrentFrame(get().project.currentFrame + delta);
  },

  setPlaying(playing) {
    set({ ui: { ...get().ui, isPlaying: playing } });
  },

  setProjectSettings(settings) {
    get().transact('Project settings', (project) => ({ ...project, ...settings }));
  },

  /* UI ------------------------------------------------------------------- */

  setUi(patch) {
    set({ ui: { ...get().ui, ...patch } });
  },

  setTool(tool) {
    set({ ui: { ...get().ui, tool } });
  },

  selectClips(clipIds, additive = false) {
    const current = get().ui.selectedClipIds;
    const next = additive ? [...new Set([...current, ...clipIds])] : clipIds;
    set({ ui: { ...get().ui, selectedClipIds: next } });
  },

  zoomBy(factor) {
    const { ui } = get();
    set({ ui: { ...ui, pixelsPerFrame: clamp(ui.pixelsPerFrame * factor, 0.05, 60) } });
  },

  /* Tracks --------------------------------------------------------------- */

  addTrack(type, name) {
    get().transact('Add track', (project) => ({
      ...project,
      tracks: [...project.tracks, createTrack(type, project.tracks.length, name)],
    }));
  },

  addTrackAt(type, order, name) {
    get().transact('Add track', (project) => {
      const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
      const index = clamp(Math.round(order), 0, ordered.length);

      ordered.splice(index, 0, createTrack(type, index, name));
      return { ...project, tracks: renumber(ordered) };
    });
  },

  updateTrack(trackId, patch) {
    get().transact('Update track', (project) => ({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === trackId ? { ...track, ...patch } : track,
      ),
    }));
  },

  removeTrack(trackId) {
    // Deleting a track takes its clips with it. That is undoable like any other
    // edit, which is why there is no confirmation prompt.
    get().transact('Delete track', (project) => {
      const clips = Object.fromEntries(
        Object.entries(project.clips).filter(([, clip]) => clip.trackId !== trackId),
      );
      return {
        ...project,
        clips,
        tracks: renumber(
          [...project.tracks].sort((a, b) => a.order - b.order).filter((t) => t.id !== trackId),
        ),
      };
    });
    set({ ui: { ...get().ui, selectedClipIds: [], selectedTrackId: null } });
  },

  moveTrack(trackId, delta) {
    get().transact('Reorder track', (project) => {
      const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((track) => track.id === trackId);
      const target = index + delta;

      if (index === -1 || target < 0 || target >= ordered.length) return project;

      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved);
      return { ...project, tracks: renumber(ordered) };
    });
  },

  /* Clips ---------------------------------------------------------------- */

  addClip(input) {
    const clip = createClip(input);
    get().transact('Add clip', (project) => ({
      ...project,
      clips: { ...project.clips, [clip.id]: clip },
    }));
    return clip.id;
  },

  addAssetToTimeline(asset, trackId, startFrame) {
    return get().addClip({
      trackId,
      name: asset.name,
      sourceUri: asset.uri,
      startFrame,
      durationFrames: Math.max(1, asset.durationFrames),
      hasAlphaChannel: asset.hasAlphaChannel,
    });
  },

  updateClip(clipId, patch, mergeKey) {
    get().transact(
      'Edit clip',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;
        return { ...project, clips: { ...project.clips, [clipId]: { ...clip, ...patch } } };
      },
      mergeKey,
    );
  },

  removeClips(clipIds) {
    if (clipIds.length === 0) return;
    const doomed = new Set(clipIds);

    get().transact('Delete clip', (project) => ({
      ...project,
      clips: Object.fromEntries(
        Object.entries(project.clips).filter(([id]) => !doomed.has(id)),
      ),
    }));
    set({ ui: { ...get().ui, selectedClipIds: [] } });
  },

  duplicateClips(clipIds) {
    if (clipIds.length === 0) return;

    const copies: Clip[] = [];
    get().transact('Duplicate clip', (project) => {
      const clips = { ...project.clips };

      for (const id of clipIds) {
        const source = project.clips[id];
        if (!source) continue;

        // The copy lands directly after the original, which is where an editor
        // expects a duplicate to appear.
        const startFrame = source.startFrame + source.durationFrames;
        const copy = moveClip({ ...structuredClone(source), id: createId('clip') }, startFrame);

        clips[copy.id] = copy;
        copies.push(copy);
      }

      return { ...project, clips };
    });

    set({ ui: { ...get().ui, selectedClipIds: copies.map((clip) => clip.id) } });
  },

  moveClipTo(clipId, trackId, startFrame) {
    const { project, ui } = get();
    const clip = project.clips[clipId];
    if (!clip) return;

    const targets = collectSnapTargets(project, { excludeClipIds: [clipId], markers: ui.markers });
    const snap = snapClipMove(startFrame, clip.durationFrames, targets, {
      pixelsPerFrame: ui.pixelsPerFrame,
      enabled: ui.snappingEnabled,
    });

    get().transact(
      'Move clip',
      (current) => {
        const target = current.clips[clipId];
        if (!target) return current;
        return {
          ...current,
          clips: {
            ...current.clips,
            [clipId]: moveClip(target, Math.max(0, snap.frame), trackId),
          },
        };
      },
      `move:${clipId}`,
    );
  },

  trimClip(clipId, edge, frame) {
    const { project, ui } = get();
    const clip = project.clips[clipId];
    if (!clip) return;

    const targets = collectSnapTargets(project, { excludeClipIds: [clipId], markers: ui.markers });
    const snapped = snapFrame(frame, targets, {
      pixelsPerFrame: ui.pixelsPerFrame,
      enabled: ui.snappingEnabled,
    }).frame;

    get().transact(
      edge === 'start' ? 'Trim clip in' : 'Trim clip out',
      (current) => {
        const target = current.clips[clipId];
        if (!target) return current;
        const trimmed =
          edge === 'start' ? trimClipStart(target, snapped) : trimClipEnd(target, snapped);
        return { ...current, clips: { ...current.clips, [clipId]: trimmed } };
      },
      `trim:${clipId}:${edge}`,
    );
  },

  razorAtFrame(frame, clipIds) {
    const { project, ui } = get();
    const cutFrame = frame ?? project.currentFrame;

    // With no explicit selection, cut whatever sits under the playhead on every
    // unlocked track - the behaviour of a razor click with nothing selected.
    const candidates =
      clipIds && clipIds.length > 0
        ? clipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip))
        : project.tracks
            .filter((track) => !track.locked)
            .map((track) => clipAtFrame(project, track.id, cutFrame))
            .filter((clip): clip is Clip => Boolean(clip));

    const splits = candidates
      .map((clip) => splitClip(clip, cutFrame))
      .filter((pair): pair is [Clip, Clip] => pair !== null);

    if (splits.length === 0) return;

    get().transact('Split clip', (current) => {
      const clips = { ...current.clips };
      for (const [left, right] of splits) {
        clips[left.id] = left;
        clips[right.id] = right;
      }
      return { ...current, clips };
    });

    set({ ui: { ...ui, selectedClipIds: splits.map(([, right]) => right.id) } });
  },

  /* Keyframes ------------------------------------------------------------ */

  setVectorKeyframe(clipId, property, frame, value) {
    get().transact(
      `Keyframe ${property}`,
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;

        const track = upsertKeyframe(clip.transform[property], frame, { ...value });
        return {
          ...project,
          clips: {
            ...project.clips,
            [clipId]: { ...clip, transform: { ...clip.transform, [property]: track } },
          },
        };
      },
      `kf:${clipId}:${property}:${frame}`,
    );
  },

  setNumberKeyframe(clipId, property, frame, value) {
    get().transact(
      `Keyframe ${property}`,
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;

        const track = upsertKeyframe(clip.transform[property], frame, value);
        return {
          ...project,
          clips: {
            ...project.clips,
            [clipId]: { ...clip, transform: { ...clip.transform, [property]: track } },
          },
        };
      },
      `kf:${clipId}:${property}:${frame}`,
    );
  },

  removeKeyframe(clipId, property, keyframeId) {
    get().transact('Delete keyframe', (project) => {
      const clip = project.clips[clipId];
      if (!clip) return project;

      const track = (clip.transform[property] as Keyframe<never>[]).filter(
        (keyframe) => keyframe.id !== keyframeId,
      );
      return {
        ...project,
        clips: {
          ...project.clips,
          [clipId]: { ...clip, transform: { ...clip.transform, [property]: track } },
        },
      };
    });
  },

  clearKeyframes(clipId, property) {
    get().transact('Clear keyframes', (project) => {
      const clip = project.clips[clipId];
      if (!clip) return project;
      return {
        ...project,
        clips: {
          ...project.clips,
          [clipId]: { ...clip, transform: { ...clip.transform, [property]: [] } },
        },
      };
    });
  },

  /* Media ---------------------------------------------------------------- */

  addAssets(assets) {
    const existing = new Set(get().assets.map((asset) => asset.uri));
    const fresh = assets.filter((asset) => !existing.has(asset.uri));
    if (fresh.length === 0) return;

    const wasEmpty = get().assets.length === 0 && Object.keys(get().project.clips).length === 0;
    set({ assets: [...get().assets, ...fresh] });

    // "New sequence from clip": an untouched project takes its frame rate and
    // resolution from the first thing imported, so 60 fps footage is not
    // silently resampled to the 30 fps default.
    if (!wasEmpty) return;

    const settings = fresh
      .map(settingsFromAsset)
      .find((entry): entry is NonNullable<ReturnType<typeof settingsFromAsset>> => entry !== null);
    if (!settings) return;

    const project = get().project;
    const fps = settings.fps ?? project.fps;

    set({
      project: {
        ...project,
        fps,
        width: settings.width ?? project.width,
        height: settings.height ?? project.height,
        // durationFrames is expressed in frames, so it has to follow the rate.
        durationFrames: Math.round((project.durationFrames / project.fps) * fps),
      },
      exportSettings: {
        ...get().exportSettings,
        fps,
        width: settings.width ?? project.width,
        height: settings.height ?? project.height,
        // The bitrate has to follow the picture size, or a vertical phone clip
        // inherits a figure meant for 1080p.
        bitrateKbps: recommendedBitrateKbps(
          settings.width ?? project.width,
          settings.height ?? project.height,
          fps,
        ),
      },
      adoptedSettingsFrom: fresh[0]?.name ?? null,
    });
  },

  removeAsset(assetId) {
    set({ assets: get().assets.filter((asset) => asset.id !== assetId) });
  },

  /* Export --------------------------------------------------------------- */

  setExportSettings(patch) {
    set({ exportSettings: { ...get().exportSettings, ...patch } });
  },
}));

/**
 * Insert a keyframe, or replace the one already sitting on `frame`.
 *
 * Returned tracks stay sorted, which every consumer of `evaluateKeyframes`
 * relies on for its binary search.
 */
function upsertKeyframe<T extends Vector2D | number>(
  track: Keyframe<T>[],
  frame: number,
  value: T,
): Keyframe<T>[] {
  const rounded = Math.round(frame);
  const existing = track.find((keyframe) => keyframe.frame === rounded);

  const next = existing
    ? track.map((keyframe) => (keyframe.frame === rounded ? { ...keyframe, value } : keyframe))
    : [...track, { id: createId('kf'), frame: rounded, value, easing: 'linear' as const }];

  return next.sort((a, b) => a.frame - b.frame);
}

/* Selectors ----------------------------------------------------------------- */

export const selectSelectedClips = (state: { project: ProjectState; ui: EditorUiState }): Clip[] =>
  state.ui.selectedClipIds
    .map((id) => state.project.clips[id])
    .filter((clip): clip is Clip => Boolean(clip));

export const selectTracksInDrawOrder = (project: ProjectState): Track[] =>
  [...project.tracks].sort((a, b) => b.order - a.order);

export const selectClipsForTrack = (project: ProjectState, trackId: string): Clip[] =>
  Object.values(project.clips)
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);

export { clipEndFrame };
