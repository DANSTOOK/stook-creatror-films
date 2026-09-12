import { create } from 'zustand';
import type {
  Clip,
  DuckingSettings,
  ExportSettings,
  Keyframe,
  Marker,
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
  retimeProject,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from '@renderer/components/Timeline/timelineOps';
import { collectSnapTargets, snapClipMove, snapFrame } from '@renderer/components/Timeline/snapping';
import { planDrop, type DropPlacement } from '@renderer/components/Timeline/dropPlacement';
import { fitZoom, playheadAnchor, revealSpan, zoomAround } from '@renderer/components/Timeline/zoom';
import {
  insertionRow,
  moveTrackRow,
  nextTrackName,
  timelineRows,
  trackAccepts,
  withRowOrders,
} from '@renderer/components/Timeline/trackRows';
import { copyClips, pasteClips, type ClipboardContent } from '@renderer/components/Timeline/clipboard';
import {
  clipsOnTrackExcept,
  closeGap,
  groupMoveCollides,
  insertIntoTrack,
  rippleDelete,
  trimLimit,
} from '@renderer/components/Timeline/trackPacking';
import { settingsFromAsset } from '@renderer/media/importMedia';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';
import { createSnapshotCommand, useHistoryStore } from './useHistoryStore';
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_UI_STATE,
  PROJECT_FILE_VERSION,
  createClip,
  createEmptyProject,
  createMarker,
  createTrack,
  normalizeProject,
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
  /** Clips copied with Ctrl+C or Ctrl+X (point 10). Not saved with the project. */
  clipboard: ClipboardContent | null;
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
  setProjectSettings(
    settings: Partial<
      Pick<ProjectState, 'fps' | 'width' | 'height' | 'durationFrames' | 'hasAlphaBackground'>
    >,
    /** Rescale the edit so it keeps its wall-clock timing when `fps` changes. */
    retime?: boolean,
  ): void;

  /* Markers -------------------------------------------------------------- */
  /** Drop a marker at `frame`, defaulting to the playhead. Returns its id. */
  addMarker(frame?: number, label?: string): string | null;
  updateMarker(markerId: string, patch: Partial<Omit<Marker, 'id'>>): void;
  removeMarker(markerId: string): void;
  clearMarkers(): void;
  /** Move the playhead to the nearest marker in `direction`. */
  goToMarker(direction: -1 | 1): void;

  /* Mixer ---------------------------------------------------------------- */
  setMasterVolume(volume: number): void;
  setDucking(patch: Partial<DuckingSettings>): void;

  /* UI ------------------------------------------------------------------- */
  setUi(patch: Partial<EditorUiState>): void;
  setTool(tool: TimelineTool): void;
  selectClips(clipIds: string[], additive?: boolean): void;
  /**
   * Zoom by `factor` around `anchorPx` (a position in the viewport); without an
   * anchor, around the playhead when it is on screen.
   */
  zoomBy(factor: number, anchorPx?: number): void;
  /** Zoom so every clip is visible - Premiere's "\". */
  zoomToFit(): void;
  /** Show `[start, end)`: scroll to it, zooming out only if it cannot fit. */
  revealFrames(start: number, end: number): void;

  /* Tracks --------------------------------------------------------------- */
  addTrack(type: TrackType, name?: string): void;
  /**
   * Insert a track at a timeline ROW (0 = top), for "add above / add below".
   * Clamped into its group: picture tracks above, audio below.
   */
  addTrackAt(type: TrackType, row?: number, name?: string): void;
  updateTrack(trackId: string, patch: Partial<Track>): void;
  removeTrack(trackId: string): void;
  /** Move a track one row up (-1) or down (+1) on screen, within its group. */
  moveTrack(trackId: string, delta: number): void;

  /* Clips ---------------------------------------------------------------- */
  addClip(input: CreateClipInput): string;
  addAssetToTimeline(asset: MediaAsset, trackId: string, startFrame: number): string;
  /**
   * Put dropped media on the timeline at the positions `planDrop` chose, as ONE
   * undoable edit - a drop of five files is one gesture, so it is one undo.
   * Placements with no track get a new track of the right type.
   */
  placeAssets(assets: readonly MediaAsset[], placements: readonly DropPlacement[]): string[];
  /**
   * The media panel's "+": put the asset at the PLAYHEAD - where Filmora puts
   * it - on the selected clip's track when that can take it, else the first
   * suitable one, pushed past anything it would cover.
   */
  addAssetAtPlayhead(asset: MediaAsset): string | null;
  /** Put the asset after the last clip on a suitable track. */
  appendAsset(asset: MediaAsset): string | null;
  /** Put the asset at the playhead on a brand new track of its own. */
  addAssetOnNewTrack(asset: MediaAsset): string | null;
  updateClip(clipId: string, patch: Partial<Clip>, mergeKey?: string): void;
  removeClips(clipIds: string[]): void;
  /** Copy a clip and drop the copy immediately after the original. */
  duplicateClips(clipIds: string[]): void;
  /** Ctrl+C: copy the selected clips. */
  copySelection(): void;
  /** Ctrl+X: copy the selected clips and delete them (the magnet applies). */
  cutSelection(): void;
  /** Ctrl+V: paste at the playhead, select the result, playhead to its end. */
  paste(): void;
  /**
   * Move a clip, inserting it where it lands: clips it would cover on that
   * track move along. `base` is the clips as they were when a drag began, so
   * the whole drag is worked out from one starting point.
   */
  moveClipTo(clipId: string, trackId: string, startFrame: number, base?: Record<string, Clip>): void;
  /**
   * Put several clips at absolute start frames at once. A group drag calls
   * this on every pointer move with the same `mergeKey`, so the whole drag is
   * one undo step.
   */
  setClipStarts(starts: ReadonlyMap<string, number>, mergeKey?: string): void;
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


/** Keep `durationFrames` at least as long as the content plus a little tail. */
function withContentLength(project: ProjectState): ProjectState {
  const content = projectContentLength(project);
  if (content <= project.durationFrames) return project;
  // Rounded: a legitimate rate can be fractional (23.976, 29.97), and adding
  // one straight to a frame count gave a project 16492260.71 frames long.
  return { ...project, durationFrames: Math.ceil(content + project.fps) };
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: createEmptyProject(),
  assets: [],
  ui: { ...DEFAULT_UI_STATE },
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  clipboard: null,
  adoptedSettingsFrom: null,

  /* Document ------------------------------------------------------------- */

  newProject(width = 1920, height = 1080, fps = 30) {
    useHistoryStore.getState().clear();
    set({
      project: createEmptyProject(width, height, fps),
      assets: [],
      // The viewport's measured width is a fact about the window, not the
      // project, and fitting depends on it.
      ui: { ...DEFAULT_UI_STATE, viewportWidthPx: get().ui.viewportWidthPx },
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
      // Older files predate the mixer and markers; normalizing on the way in
      // means nothing downstream has to defend against a missing field.
      // Every other path that adds clips grows the project through
      // `transact`; opening a file was the one that did not, so a document
      // whose stored duration was shorter than its clips opened with the
      // playhead unable to reach them.
      project: withContentLength(normalizeProject(document.project)),
      assets: document.assets,
      // The viewport's measured width is a fact about the window, not the
      // project, and fitting depends on it.
      ui: { ...DEFAULT_UI_STATE, viewportWidthPx: get().ui.viewportWidthPx },
      exportSettings: {
        ...DEFAULT_EXPORT_SETTINGS,
        width: document.project.width,
        height: document.project.height,
        fps: document.project.fps,
        // Zero means "the whole timeline", resolved when the export dialog
      // opens. Storing the length the project had when it was saved froze
      // the export range at that number for the rest of the session.
      endFrame: 0,
      },
    });
  },

  toDocument() {
    const { project, assets } = get();
    return {
      version: PROJECT_FILE_VERSION,
      savedAt: new Date().toISOString(),
      project,
      // The blob URL is dead on reopen, but it is kept anyway: it is the only
      // link between a clip's `sourceUri` and the asset it came from, and
      // rehydration needs it to remap them onto the fresh URLs.
      assets,
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

  setProjectSettings(settings, retime = true) {
    get().transact('Project settings', (project) => {
      // A frame rate change reinterprets every frame number in the document, so
      // it is applied through `retimeProject` rather than by assignment: the
      // edit keeps its wall-clock timing and only the grid underneath changes.
      const rated =
        settings.fps !== undefined && settings.fps !== project.fps && retime
          ? retimeProject(project, settings.fps)
          : project;

      return { ...rated, ...settings };
    });

    // The export settings mirror the project, and a stale resolution here is
    // how a 1080p project ends up rendering at whatever the last import was.
    const project = get().project;
    get().setExportSettings({
      width: project.width,
      height: project.height,
      fps: project.fps,
      bitrateKbps: recommendedBitrateKbps(project.width, project.height, project.fps),
    });
  },

  /* Markers -------------------------------------------------------------- */

  addMarker(frame, label) {
    const { project } = get();
    const target = Math.max(0, Math.round(frame ?? project.currentFrame));

    // One marker per frame: a second one at the same spot is invisible on the
    // ruler and would be undeletable from the UI.
    const existing = project.markers.find((marker) => marker.frame === target);
    if (existing) {
      set({ ui: { ...get().ui, selectedMarkerId: existing.id } });
      return null;
    }

    const marker = createMarker(target, label);
    get().transact('Add marker', (current) => ({
      ...current,
      markers: [...current.markers, marker].sort((a, b) => a.frame - b.frame),
    }));
    set({ ui: { ...get().ui, selectedMarkerId: marker.id } });
    return marker.id;
  },

  updateMarker(markerId, patch) {
    get().transact('Edit marker', (project) => {
      const markers = project.markers
        .map((marker) =>
          marker.id === markerId
            ? {
                ...marker,
                ...patch,
                frame:
                  patch.frame === undefined
                    ? marker.frame
                    : Math.max(0, Math.round(patch.frame)),
              }
            : marker,
        )
        .sort((a, b) => a.frame - b.frame);

      return { ...project, markers };
    });
  },

  removeMarker(markerId) {
    get().transact('Delete marker', (project) => ({
      ...project,
      markers: project.markers.filter((marker) => marker.id !== markerId),
    }));
    set({ ui: { ...get().ui, selectedMarkerId: null } });
  },

  clearMarkers() {
    if (get().project.markers.length === 0) return;
    get().transact('Clear markers', (project) => ({ ...project, markers: [] }));
    set({ ui: { ...get().ui, selectedMarkerId: null } });
  },

  goToMarker(direction) {
    const { project } = get();
    const here = project.currentFrame;

    const candidate =
      direction === 1
        ? project.markers.find((marker) => marker.frame > here)
        : [...project.markers].reverse().find((marker) => marker.frame < here);

    if (!candidate) return;
    get().setCurrentFrame(candidate.frame);
    set({ ui: { ...get().ui, selectedMarkerId: candidate.id } });
  },

  /* Mixer ---------------------------------------------------------------- */

  setMasterVolume(volume) {
    get().transact(
      'Master volume',
      (project) => ({
        ...project,
        audio: { ...project.audio, masterVolume: clamp(volume, 0, 2) },
      }),
      'master-volume',
    );
  },

  setDucking(patch) {
    get().transact(
      'Auto ducking',
      (project) => ({
        ...project,
        audio: { ...project.audio, ducking: { ...project.audio.ducking, ...patch } },
      }),
      'ducking',
    );
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

  zoomBy(factor, anchorPx) {
    const { ui, project } = get();
    const view = { pixelsPerFrame: ui.pixelsPerFrame, scrollLeftPx: ui.scrollLeftPx };
    const anchor = anchorPx ?? playheadAnchor(view, project.currentFrame, ui.viewportWidthPx);
    set({ ui: { ...ui, ...zoomAround(view, factor, anchor) } });
  },

  zoomToFit() {
    const { ui, project } = get();
    // An empty timeline fits its first half minute rather than nothing.
    const frames = projectContentLength(project) || project.fps * 30;
    const pixelsPerFrame = fitZoom(frames, ui.viewportWidthPx);
    if (pixelsPerFrame === null) return;
    set({ ui: { ...ui, pixelsPerFrame, scrollLeftPx: 0 } });
  },

  revealFrames(start, end) {
    const { ui, project } = get();
    const next = revealSpan(
      { pixelsPerFrame: ui.pixelsPerFrame, scrollLeftPx: ui.scrollLeftPx },
      start,
      end,
      projectContentLength(project),
      ui.viewportWidthPx,
    );
    set({ ui: { ...ui, ...next } });
  },

  /* Tracks --------------------------------------------------------------- */

  addTrack(type, name) {
    // A new picture track goes on top of the others, a new audio track under
    // the last one - where every editor puts them.
    get().addTrackAt(type, undefined, name);
  },

  addTrackAt(type, row, name) {
    get().transact('Add track', (project) => {
      const rows = timelineRows(project.tracks);
      const at = insertionRow(rows, type, row === undefined ? undefined : Math.round(row));
      rows.splice(at, 0, createTrack(type, 0, name ?? nextTrackName(project.tracks, type)));
      return { ...project, tracks: withRowOrders(rows) };
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
        tracks: withRowOrders(timelineRows(project.tracks).filter((t) => t.id !== trackId)),
      };
    });
    set({ ui: { ...get().ui, selectedClipIds: [], selectedTrackId: null } });
  },

  moveTrack(trackId, delta) {
    get().transact('Reorder track', (project) => {
      // One row up or down on screen, never out of its group: a picture track
      // does not go below the audio.
      const rows = moveTrackRow(timelineRows(project.tracks), trackId, delta < 0 ? -1 : 1);
      return rows ? { ...project, tracks: withRowOrders(rows) } : project;
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

  placeAssets(assets, placements) {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const created: string[] = [];
    const placed: [number, number][] = [];

    get().transact('Add clips', (project) => {
      let rows = timelineRows(project.tracks);
      const clips = { ...project.clips };
      const newTracks = new Map<Track['type'], string>();

      for (const placement of placements) {
        const asset = byId.get(placement.assetId);
        if (!asset) continue;

        let trackId = placement.trackId;
        if (!trackId) {
          // One new track per type, shared by every placement that needs it,
          // where a new track of that type goes: pictures on top, audio last.
          trackId = newTracks.get(placement.trackType) ?? null;
          if (!trackId) {
            const track = createTrack(placement.trackType, 0, nextTrackName(rows, placement.trackType));
            rows = [...rows];
            rows.splice(insertionRow(rows, placement.trackType), 0, track);
            newTracks.set(placement.trackType, track.id);
            trackId = track.id;
          }
        }

        // Inserted where it was put: a still dropped just before a video goes
        // there and the video moves along, instead of the two overlapping in
        // the export (point 8).
        const insertion = insertIntoTrack(
          clipsOnTrackExcept(clips, trackId, new Set()),
          placement.startFrame,
          placement.durationFrames,
        );
        for (const [id, start] of insertion.shifts) clips[id] = moveClip(clips[id], start);

        const clip = createClip({
          trackId,
          name: asset.name,
          sourceUri: asset.uri,
          startFrame: insertion.startFrame,
          durationFrames: placement.durationFrames,
          hasAlphaChannel: asset.hasAlphaChannel,
        });
        clips[clip.id] = clip;
        created.push(clip.id);
        placed.push([insertion.startFrame, insertion.startFrame + placement.durationFrames]);
      }

      return created.length > 0 ? { ...project, tracks: withRowOrders(rows), clips } : project;
    });

    if (created.length > 0) {
      set({ ui: { ...get().ui, selectedClipIds: created } });

      // Whatever was just added is shown. It used to land wherever it landed,
      // often far off to the right, and the editor had to go and find it.
      get().revealFrames(Math.min(...placed.map(([start]) => start)), Math.max(...placed.map(([, end]) => end)));
    }
    return created;
  },

  addAssetAtPlayhead(asset) {
    const { project, ui } = get();
    const selected = ui.selectedClipIds.map((id) => project.clips[id]).find(Boolean);
    const placements = planDrop(project, [asset], selected?.trackId ?? null, project.currentFrame);
    return get().placeAssets([asset], placements)[0] ?? null;
  },

  appendAsset(asset) {
    const { project } = get();
    // Plan once to learn which track it goes on, then again at that track's end.
    const [probe] = planDrop(project, [asset], null, 0);
    const end = probe.trackId
      ? Object.values(project.clips)
          .filter((clip) => clip.trackId === probe.trackId)
          .reduce((latest, clip) => Math.max(latest, clipEndFrame(clip)), 0)
      : 0;
    return get().placeAssets([asset], planDrop(project, [asset], probe.trackId, end))[0] ?? null;
  },

  addAssetOnNewTrack(asset) {
    const { project } = get();
    const [placement] = planDrop(project, [asset], null, project.currentFrame);
    // A new track is empty, so the playhead position is free by definition.
    return (
      get().placeAssets([asset], [
        { ...placement, trackId: null, startFrame: project.currentFrame },
      ])[0] ?? null
    );
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

    const ripple = get().ui.rippleEnabled;
    get().transact('Delete clip', (project) => {
      const clips = Object.fromEntries(Object.entries(project.clips).filter(([id]) => !doomed.has(id)));
      // The magnet: what came after a deleted clip closes up behind it.
      if (ripple) {
        for (const [id, start] of rippleDelete(project.clips, doomed)) clips[id] = moveClip(clips[id], start);
      }
      return { ...project, clips };
    });
    set({ ui: { ...get().ui, selectedClipIds: [] } });
  },

  copySelection() {
    const { project, ui } = get();
    const content = copyClips(project, ui.selectedClipIds);
    if (content) set({ clipboard: content });
  },

  cutSelection() {
    const { ui } = get();
    if (ui.selectedClipIds.length === 0) return;
    get().copySelection();
    get().removeClips(ui.selectedClipIds);
  },

  paste() {
    const { clipboard, assets } = get();
    if (!clipboard) return;

    let result: ReturnType<typeof pasteClips> | null = null;
    get().transact('Paste', (project) => {
      result = pasteClips(project, clipboard, project.currentFrame, assets);
      return result.pastedIds.length > 0 ? { ...project, clips: result.clips } : project;
    });

    const pasted = result as ReturnType<typeof pasteClips> | null;
    if (!pasted || pasted.pastedIds.length === 0) return;
    // Pasted clips are selected, and the playhead moves past them, so pressing
    // Ctrl+V again lays the next copy right after this one.
    set({ ui: { ...get().ui, selectedClipIds: pasted.pastedIds } });
    get().setCurrentFrame(pasted.endFrame);
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
        // expects a duplicate to appear - inserted, so a clip that was right
        // after the original moves along rather than being covered.
        const insertion = insertIntoTrack(
          clipsOnTrackExcept(clips, source.trackId, new Set()),
          source.startFrame + source.durationFrames,
          source.durationFrames,
        );
        for (const [shiftedId, start] of insertion.shifts) clips[shiftedId] = moveClip(clips[shiftedId], start);
        const copy = moveClip({ ...structuredClone(source), id: createId('clip') }, insertion.startFrame);

        clips[copy.id] = copy;
        copies.push(copy);
      }

      return { ...project, clips };
    });

    set({ ui: { ...get().ui, selectedClipIds: copies.map((clip) => clip.id) } });
  },

  moveClipTo(clipId, trackId, startFrame, base) {
    const { project, ui, assets } = get();
    const clip = project.clips[clipId];
    if (!clip) return;

    // Sound stays on audio tracks and pictures on picture tracks; a drag onto
    // the wrong kind keeps the clip on its own track and only moves it in time.
    const target = project.tracks.find((track) => track.id === trackId);
    const kind = assets.find((asset) => asset.uri === clip.sourceUri)?.kind;
    if (!target || target.locked || !trackAccepts(target, kind)) trackId = clip.trackId;

    // Everything is worked out from the clips as they were when the drag
    // began: a clip pushed aside a moment ago goes back when the dragged one
    // moves on, instead of staying pushed.
    const from = base ?? project.clips;
    const targets = collectSnapTargets({ ...project, clips: from }, { excludeClipIds: [clipId] });
    const snap = snapClipMove(startFrame, clip.durationFrames, targets, {
      pixelsPerFrame: ui.pixelsPerFrame,
      enabled: ui.snappingEnabled,
    });

    get().transact(
      'Move clip',
      (current) => {
        const moving = current.clips[clipId];
        if (!moving) return current;

        const clips = { ...current.clips };
        if (base) {
          for (const [id, original] of Object.entries(base)) if (id !== clipId && clips[id]) clips[id] = original;
        }

        // The magnet (point 9): the hole the clip leaves where it was closes
        // up, before it is inserted where it lands. Worked out from where it
        // started, so on its own track this reorders clips without gaps.
        const origin = base?.[clipId] ?? moving;
        if (ui.rippleEnabled) {
          for (const [id, start] of closeGap(clips, origin.trackId, clipEndFrame(origin), origin.durationFrames, new Set([clipId]))) {
            clips[id] = moveClip(clips[id], start);
          }
        }

        // Inserted where it lands; whatever it would cover moves along (point 8).
        const insertion = insertIntoTrack(
          clipsOnTrackExcept(clips, trackId, new Set([clipId])),
          Math.max(0, snap.frame),
          moving.durationFrames,
        );
        for (const [id, start] of insertion.shifts) clips[id] = moveClip(clips[id], start);
        clips[clipId] = moveClip(moving, insertion.startFrame, trackId);
        return { ...current, clips };
      },
      `move:${clipId}`,
    );
  },

  setClipStarts(starts, mergeKey) {
    get().transact(
      'Move clips',
      (project) => {
        // A group stops against a clip that is not moving rather than landing
        // on it (point 8).
        if (groupMoveCollides(project.clips, starts)) return project;

        const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
        const clips = { ...project.clips };
        let changed = false;

        for (const [id, start] of starts) {
          const clip = clips[id];
          if (!clip || locked.has(clip.trackId)) continue;
          const next = Math.max(0, Math.round(start));
          if (next === clip.startFrame) continue;
          // moveClip, not a bare startFrame write: keyframes are stored in
          // timeline time and have to travel with their clip.
          clips[id] = moveClip(clip, next);
          changed = true;
        }

        return changed ? { ...project, clips } : project;
      },
      mergeKey,
    );
  },

  trimClip(clipId, edge, frame) {
    const { project, ui } = get();
    const clip = project.clips[clipId];
    if (!clip) return;

    const targets = collectSnapTargets(project, { excludeClipIds: [clipId] });
    let snapped = snapFrame(frame, targets, {
      pixelsPerFrame: ui.pixelsPerFrame,
      enabled: ui.snappingEnabled,
    }).frame;

    // With the magnet, trimming the end carries the rest of the track along
    // (a ripple trim), so it neither leaves a hole nor runs into the next clip.
    const rippleEnd = edge === 'end' && ui.rippleEnabled;

    // Otherwise an edge stops at its neighbour: a trimmed clip never grows
    // over the next one on its track (point 8 - clips never overlap).
    if (!rippleEnd) {
      const limit = trimLimit(project.clips, clip, edge);
      snapped = edge === 'start' ? Math.max(snapped, limit) : Math.min(snapped, limit);
    }

    get().transact(
      edge === 'start' ? 'Trim clip in' : 'Trim clip out',
      (current) => {
        const target = current.clips[clipId];
        if (!target) return current;
        const trimmed =
          edge === 'start' ? trimClipStart(target, snapped) : trimClipEnd(target, snapped);
        const clips = { ...current.clips, [clipId]: trimmed };

        if (rippleEnd) {
          // Everything after the old end moves by exactly what the end moved.
          const delta = clipEndFrame(trimmed) - clipEndFrame(target);
          for (const other of Object.values(current.clips)) {
            if (other.id === clipId || other.trackId !== target.trackId) continue;
            if (other.startFrame < clipEndFrame(target)) continue;
            clips[other.id] = moveClip(other, Math.max(0, other.startFrame + delta));
          }
        }
        return { ...current, clips };
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

    // The assets were measured in frames at the OLD rate, because the import
    // ran before the project adopted the new one. Left alone, a 60 fps clip in
    // a project that was at 30 would land on the timeline at half its length.
    const ratio = fps / project.fps;
    if (ratio !== 1) {
      const rescaled = new Set(fresh.map((asset) => asset.id));
      set({
        assets: get().assets.map((asset) =>
          rescaled.has(asset.id)
            ? { ...asset, durationFrames: Math.max(1, Math.round(asset.durationFrames * ratio)) }
            : asset,
        ),
      });
    }

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
