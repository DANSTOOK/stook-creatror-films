import { create } from 'zustand';
import type {
  CaptionAnimation,
  CaptionLanguage,
  CaptionLook,
  CaptionPreset,
  CaptionTrackSettings,
  Clip,
  ColorGradingConfig,
  DuckingSettings,
  ExportSettings,
  Keyframe,
  Marker,
  MediaAsset,
  ProjectState,
  TitleAnimation,
  TitleContent,
  TitleOrigin,
  TitlePreset,
  TitleStyle,
  Track,
  TrackType,
  Transition,
  Vector2D,
} from '@shared/types';
import { createTitleClip, planTitlePlacement, titleDropPlacement, TITLE_NAME, TITLE_SECONDS, TITLE_TEXT } from '@renderer/text/titleClip';
import { normalizeTitleStyle, titleName } from '@renderer/text/titleStyle';
import { NO_ANIMATION, normalizeAnimation } from '@renderer/text/animation';
import {
  createTransition,
  headHandle,
  MIN_TRANSITION_FRAMES,
  overlapClips,
  planTransition,
  tailHandle,
  tidyTransitions,
  transitionsOf,
  type TransitionPreset,
  presetKind,
} from '@renderer/timing/transitions';
import { t as translateNow } from '@renderer/i18n';
import { captionName, captionSettingsOf, captionTrack, createCaptionClip, cuesToClips, mergeCaptionClips, splitCaption, subtitleCuesToClips } from '@renderer/captions/captionClips';
import { normalizeCaptionAnimation } from '@renderer/captions/animation';
import { normalizeGlossary } from '@renderer/captions/glossary';
import { fixTiming, reflowText, rulesFor, type Cue } from '@renderer/captions/rules';
import { followCaptions, linkCaptions, unlinkCaptions, type SoundOf } from '@renderer/captions/follow';
import { replaceInText, type FindOptions } from '@renderer/captions/findReplace';
import { lookOf, normalizeLook } from '@renderer/captions/look';
import type { SubtitleCue } from '@renderer/captions/subtitleFiles';
import { newTransitionFrames } from '@renderer/timing/transitionLength';
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
import { assetLengthFrames } from '@renderer/media/assetLength';
import { fitScale } from '@renderer/media/fitToFrame';
import { clearRange, editLength } from '@renderer/components/Timeline/threePoint';
import { rippleTrim, rollEdit, slideClip, slipClip } from '@renderer/components/Timeline/trimModes';
import { retimed, speedOf } from '@renderer/timing/clipSpeed';
import { fadeFromDrag } from '@renderer/timing/clipFades';
import {
  clipTrimRoom,
  expandSelection,
  linkClips,
  partnersOf,
  regroupCopies,
  sharedTrimDelta,
  tidyLinkGroups,
  unlinkClips,
} from '@renderer/components/Timeline/linkGroups';
import { rangeLength, withInPoint, withOutPoint } from './markRange';
import { fitZoom, playheadAnchor, revealSpan, zoomAround } from '@renderer/components/Timeline/zoom';
import {
  insertionRow,
  moveTrackRow,
  nextTrackName,
  timelineRows,
  clipKind,
  trackAccepts,
  withRowOrders,
} from '@renderer/components/Timeline/trackRows';
import { copyClips, pasteClips, type ClipboardContent } from '@renderer/components/Timeline/clipboard';
import {
  clipsOnTrackExcept,
  closeGap,
  groupMoveCollides,
  insertIntoTrack,
  nudgeHopDelta,
  planGroupMove,
  rippleDelete,
  trimLimit,
  type GroupMoveOptions,
} from '@renderer/components/Timeline/trackPacking';
import { remapClipSources, settingsFromAsset } from '@renderer/media/importMedia';
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
  type PendingTransition,
  type ProjectDocument,
  type TimelineTool,
} from './types';
import type { MediaBin } from '@shared/types';
import {
  createBin as createMediaBin,
  deleteBin as deleteMediaBin,
  ensureBinPath as ensureMediaBinPath,
  moveAssetsToBin as moveMediaAssets,
  renameBin as renameMediaBin,
  librarySnapshot,
  restoreLibrary,
  sanitizeBins,
  type LibrarySnapshot,
} from '@renderer/media/bins';
import { createLibraryCommand } from './useHistoryStore';

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
  /** Library bins (folders). See media/bins.ts. */
  bins: MediaBin[];
  /** The bin the media panel shows, and where imports land. Null is the top level. */
  currentBinId: string | null;
  ui: EditorUiState;
  exportSettings: ExportSettings;
  /** Clips copied with Ctrl+C or Ctrl+X (point 10). Not saved with the project. */
  clipboard: ClipboardContent | null;
  /** A clip's whole grade, copied with Ctrl+Alt+C. Not saved with the project. */
  gradeClipboard: ColorGradingConfig | null;
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

  /* The marked range, and the shuttle ------------------------------------- */
  /** Mark the in point at `frame`, or at the playhead (I). */
  markIn(frame?: number): void;
  /** Mark the out point, which sits one past the frame it keeps (O). */
  markOut(frame?: number): void;
  clearMarks(): void;
  /**
   * Play at a speed and direction: 1 plays, 8 is L pressed three times, -2
   * runs backwards, 0 stops (J, K, L).
   */
  setPlaybackRate(rate: number): void;

  /**
   * Three-point edits from the library clip in hand.
   *
   * The marked range says how long and where; the source says what. Insert
   * pushes what follows along, overwrite replaces what it covers.
   */
  insertSelectedAsset(): void;
  overwriteSelectedAsset(): void;
  /**
   * Select clips, bringing in every linked partner of what is named.
   * `exact` keeps to the clips given - Alt+click, to work on one half of
   * a linked pair without breaking the link.
   */
  selectClips(clipIds: string[], additive?: boolean, exact?: boolean): void;

  /* Linked clips -------------------------------------------------------- */
  /** Link the selection, so it moves, trims and is deleted as one. */
  linkSelection(): void;
  /** Take the selection out of its link groups. */
  unlinkSelection(): void;
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

  /* Titles --------------------------------------------------------------- */
  /**
   * A new title from a template, at the playhead, above the picture there
   * (see text/titleClip). Selected and shown. Returns its id. `at` is a
   * drop from the Titles panel: that track and frame when they are free.
   */
  addTitle(preset: TitlePreset, at?: { trackId: string | null; startFrame: number }): string;
  /**
   * Change a title's text or look. The clip's name follows its first line.
   * A typing run or a drag with one `mergeKey` is one undo step.
   */
  updateTitle(
    clipId: string,
    patch: { text?: string; preset?: TitlePreset; style?: Partial<TitleStyle>; animation?: Partial<TitleAnimation>; origin?: TitleOrigin },
    mergeKey?: string,
  ): void;
  /**
   * Typing into a title in the viewer: the text changes on screen at once,
   * and stays out of the history until `commitTitleText` - so however long
   * the typing pauses, the whole edit is one undo step.
   */
  setTitleTextLive(clipId: string, text: string): void;

  /* Transitions ---------------------------------------------------------- */
  /**
   * Ctrl+T (and Ctrl+D): a transition on each cut at the ends of the
   * selected clips - a fade where an end has no neighbour - or, with nothing
   * selected, on the cut nearest the playhead. `cuts` names cuts outright
   * (the timeline's menu). Where a cut lacks the footage, nothing happens
   * yet: `ui.pendingTransition` asks the editor (see resolvePendingTransition).
   */
  addTransitions(preset?: TransitionPreset, cuts?: Array<{ fromId: string; toId: string }>): void;
  /**
   * A transition dropped from the panel on a cut: added there (asking when
   * footage is short), or, where the cut has one already, that one becomes
   * the dropped kind - as Final Cut replaces it - keeping its length.
   */
  dropTransition(preset: TransitionPreset, cut: { fromId: string; toId: string }): void;
  /** The editor's answer: overlap the clips, freeze frames, or leave it. One undo step. */
  resolvePendingTransition(choice: 'overlap' | 'freeze' | 'cancel'): void;
  updateTransition(transitionId: string, patch: Partial<Omit<Transition, 'id' | 'fromClipId' | 'toClipId'>>, mergeKey?: string): void;
  removeTransition(transitionId: string): void;
  /** Pick a transition on the timeline; the clip selection is cleared. */
  selectTransition(transitionId: string | null): void;
  /** The typing is over: one undo step, from `fromText` to what is there now. */
  commitTitleText(clipId: string, fromText: string): void;
  /* Captions ------------------------------------------------------------- */
  /**
   * A new captions track on top of the picture, holding these captions:
   * cues from a transcription (seconds from `offsetFrame`) or from a
   * subtitle file (milliseconds). One undo step; returns the track's id.
   */
  addCaptionTrack(
    source: { cues: Cue[]; offsetFrame: number; sourceTrackId?: string } | { subtitles: SubtitleCue[] },
    settings: CaptionTrackSettings,
  ): string;
  /**
   * A caption's text; a typing run with the same `mergeKey` is one undo step.
   * Its lines are laid out again by the rules as it changes - unless they are
   * its author's (`manual`: Enter was pressed, or they were before).
   */
  setCaptionText(clipId: string, text: string, mergeKey?: string, manual?: boolean): void;
  /** Whose the line breaks are: the author's, or (false) the rules' again, laid out now. */
  setCaptionBreaks(clipId: string, manual: boolean): void;
  /** Join a caption with the one after or before it on its track. Returns the joined caption's id. */
  mergeCaptions(clipId: string, direction: 'next' | 'previous'): string | null;
  /**
   * Put right the timing that can safely be put right (rules.fixTiming), on
   * a whole track or on the captions named. One undo step; returns how many changed.
   */
  fixCaptionTiming(trackId: string, clipIds?: readonly string[]): number;
  /**
   * Replace in the captions of a track: every match, or the one named. One
   * undo step; returns how many were replaced.
   */
  replaceInCaptions(trackId: string, query: string, replacement: string, options?: FindOptions & { only?: { clipId: string; occurrence: number } }): number;
  /** A track's look: a change to it, or null for its preset's own again. */
  setCaptionLook(trackId: string, patch: Partial<CaptionLook> | null, mergeKey?: string): void;
  /** A track's preset - its line rules and, with them, its look. */
  setCaptionPreset(trackId: string, preset: CaptionPreset): void;
  /** How a track's captions move word by word, or null for not at all. */
  setCaptionAnimation(trackId: string, animation: CaptionAnimation | null, mergeKey?: string): void;
  /** The language a track's captions are in: its tag in an export, and its line rules. */
  setCaptionLanguage(trackId: string, language: CaptionLanguage): void;
  /** A captions track with nothing on it yet, for captions typed by hand. One undo step; returns its id. */
  addEmptyCaptionTrack(settings: CaptionTrackSettings): string;
  /**
   * A caption typed by hand on a track at a frame: it fills the free time
   * there, up to a few seconds. Returns its id, or null if a caption is
   * already at that frame or the track is locked.
   */
  addCaptionAt(trackId: string, frame: number, text: string): string | null;
  /** The project's names and terms (captions/glossary.ts). */
  setGlossary(terms: readonly string[]): void;
  /** Tie captions to the footage under them, so they follow it (captions/follow.ts). */
  linkCaptionsToClips(clipIds: readonly string[]): number;
  /** Set captions free of their clips: they stay where they are. */
  unlinkCaptionsFromClips(clipIds: readonly string[]): void;


  removeClips(clipIds: string[]): void;
  /** Copy a clip and drop the copy immediately after the original. */
  duplicateClips(clipIds: string[]): void;
  /** Ctrl+C: copy the selected clips. */
  copySelection(): void;
  /** Ctrl+X: copy the selected clips and delete them (the magnet applies). */
  cutSelection(): void;
  /** Ctrl+V: paste at the playhead, select the result, playhead to its end. */
  paste(): void;
  /** Ctrl+Alt+C: copy a clip's grade - the first selected one's by default. */
  copyGrade(clipId?: string): void;
  /**
   * Ctrl+Alt+V: give the copied grade to these clips (the selection by
   * default), audio clips left out. One undo step, however many clips.
   */
  pasteGrade(clipIds?: string[]): void;
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
  /**
   * Move several clips together, by the rules a single clip follows: the
   * holes they leave close with the magnet, and what they land on moves
   * along. `base` is the clips when a drag began, so the whole drag is
   * placed from one starting point and pushed clips go back.
   */
  moveClipGroup(
    clipIds: readonly string[],
    deltaFrames: number,
    deltaTracks: number,
    options?: { base?: Record<string, Clip>; anchorId?: string; mergeKey?: string; ripple?: boolean },
  ): void;
  /**
   * Arrow keys: move the selected clips by frames, or a track up or down.
   * A nudge a neighbouring clip blocks hops over that clip instead.
   * `repeat` (a held key) folds the moves into one undo step.
   */
  nudgeSelection(frames: number, tracks: number, repeat?: boolean): void;
  trimClip(clipId: string, edge: 'start' | 'end', frame: number): void;

  /* Fades ---------------------------------------------------------------- */
  /**
   * Set the fade at one end of a clip, in frames.
   *
   * A whole drag is one undo step: the merge key is the clip and the end
   * being dragged, so pushing the handle back and forth lands as one.
   */
  setClipFade(clipId: string, edge: 'in' | 'out', frames: number): void;

  /* Speed ---------------------------------------------------------------- */
  /**
   * Retime a clip: the footage it shows stays, the time it takes changes.
   *
   * `ripple` moves everything after it on that track, which is Premiere's
   * "Ripple Edit, Shifting Trailing Clips"; without it the clip stops at
   * its neighbour rather than growing over it, by the rule every trim here
   * already follows.
   */
  setClipSpeed(clipId: string, change: { speed: number; reversed: boolean; ripple: boolean }): void;

  /* The trim tool -------------------------------------------------------- */
  /** Drag one edge and take the rest of the track with it. */
  rippleTrimClip(clipId: string, edge: 'start' | 'end', frame: number): void;
  /** Move the join between two touching clips; the timeline keeps its length. */
  rollEditAt(leftId: string, rightId: string, frame: number): void;
  /**
   * Change which footage a clip shows without moving it (slip), or move it
   * between its neighbours, which give and take (slide). `base` is the clips
   * as the drag began, so the whole drag is worked out from one start and
   * lands as a single undo step.
   */
  slipClipBy(clipId: string, deltaFrames: number, base: Record<string, Clip>): void;
  slideClipBy(clipId: string, deltaFrames: number, base: Record<string, Clip>): void;
  /** Razor tool: split at the playhead. */
  razorAtFrame(frame?: number, clipIds?: string[]): void;

  /* Keyframes ------------------------------------------------------------ */
  setVectorKeyframe(clipId: string, property: VectorProperty, frame: number, value: Vector2D): void;
  setNumberKeyframe(clipId: string, property: NumberProperty, frame: number, value: number): void;
  /**
   * Write several transform properties at one frame as a single edit.
   *
   * Dragging a clip in the viewer moves and scales it at the same time; as two
   * separate keyframe edits, undo would take back half a drag.
   */
  setTransformAt(
    clipId: string,
    frame: number,
    patch: { position?: Vector2D; scale?: Vector2D; rotation?: number },
  ): void;
  removeKeyframe(clipId: string, property: VectorProperty | NumberProperty, keyframeId: string): void;
  clearKeyframes(clipId: string, property: VectorProperty | NumberProperty): void;

  /* Media ---------------------------------------------------------------- */
  /** Assets without a bin of their own go into `binId`, or the current bin when it is omitted. */
  addAssets(assets: MediaAsset[], binId?: string | null): void;
  removeAsset(assetId: string): void;

  /**
   * Point an asset at its proxy - the small stand-in the preview draws while
   * editing. Not an undoable edit: it says what is on disk, not what the
   * project is, and undoing a build would not delete the file anyway.
   */
  setAssetProxy(assetId: string, proxyUri: string): void;
  /**
   * Missing files found again: each asset gets its new path (and URL, when
   * it had to change) and is no longer missing; clips follow the URL.
   */
  relinkAssets(changes: ReadonlyArray<{ assetId: string; sourcePath: string; uri: string; audioUri?: string }>): void;

  /* Media bins ----------------------------------------------------------- */
  setCurrentBin(binId: string | null): void;
  /** Returns the new bin's id. */
  createBin(parentId: string | null, name?: string): string;
  renameBin(binId: string, name: string): void;
  /** Its clips and sub-bins move up into its parent; nothing leaves the library. */
  deleteBin(binId: string): void;
  moveAssetsToBin(assetIds: string[], binId: string | null): void;
  /** Bins for a folder path under `parentId`, created where missing; returns the deepest. */
  ensureBinPath(parentId: string | null, segments: string[]): string | null;

  /* Export --------------------------------------------------------------- */
  setExportSettings(patch: Partial<ExportSettings>): void;
}


/** Record an applied bin edit as one undo step; an edit that changed nothing is not recorded. */
function pushLibraryEdit(label: string, before: LibrarySnapshot, after: LibrarySnapshot): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  useHistoryStore.getState().push(createLibraryCommand(label, before, after));
}

/**
 * The library as an undo or redo of a bin edit leaves it, or nothing when the
 * step was a timeline edit. The bin on show stays on show if it still exists.
 */
function libraryAt(
  state: { assets: MediaAsset[]; currentBinId: string | null },
  snapshot: LibrarySnapshot | undefined,
): Partial<{ bins: MediaBin[]; assets: MediaAsset[]; currentBinId: string | null }> {
  if (!snapshot) return {};
  const restored = restoreLibrary(state.assets, snapshot);
  const current = state.currentBinId;
  return { ...restored, currentBinId: current && restored.bins.some((bin) => bin.id === current) ? current : null };
}

/** Keep `durationFrames` at least as long as the content plus a little tail. */
/** How sure it is that a clip carries sound, from the library: for tying captions to footage. */
function soundOfAssets(assets: readonly MediaAsset[]): SoundOf {
  const byUri = new Map(assets.map((asset) => [asset.uri, asset]));
  return (clip) => {
    const asset = byUri.get(clip.sourceUri);
    if (!asset || asset.kind === 'image') return 0;
    // A video's sound is known only once it has been pulled out of the file.
    return asset.kind === 'audio' || asset.audioUri ? 2 : 1;
  };
}

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
  bins: [],
  currentBinId: null,
  ui: { ...DEFAULT_UI_STATE },
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  clipboard: null,
  gradeClipboard: null,
  adoptedSettingsFrom: null,

  /* Document ------------------------------------------------------------- */

  newProject(width = 1920, height = 1080, fps = 30) {
    useHistoryStore.getState().clear();
    set({
      project: createEmptyProject(width, height, fps),
      assets: [],
      bins: [],
      currentBinId: null,
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
      // Files from before bins have none; a damaged list is repaired, not trusted.
      bins: sanitizeBins(document.bins),
      currentBinId: null,
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
    const { project, assets, bins } = get();
    return {
      version: PROJECT_FILE_VERSION,
      savedAt: new Date().toISOString(),
      project,
      // The blob URL is dead on reopen, but it is kept anyway: it is the only
      // link between a clip's `sourceUri` and the asset it came from, and
      // rehydration needs it to remap them onto the fresh URLs.
      assets,
      bins,
    };
  },

  /* History -------------------------------------------------------------- */

  transact(label, mutate, mergeKey) {
    const before = get().project;
    // Captions follow their footage: whatever the edit did to a clip, it did to its captions.
    const after = withContentLength(followCaptions(before, tidyTransitions(mutate(before)), soundOfAssets(get().assets)));
    if (after === before) return;

    useHistoryStore.getState().push(createSnapshotCommand(label, before, after, mergeKey));
    set({ project: after });
  },

  // Undo and redo keep the selection, less any clip the step removed. They
  // used to clear it, so undoing a group move meant selecting the whole group
  // again before trying the move a second time.
  undo() {
    const history = useHistoryStore.getState();
    // Read before undoing: a bin edit carries the library to put back.
    const command = history.peekUndo();
    const reverted = history.undo(get().project);
    if (!reverted) return;
    set({
      project: reverted,
      ui: keepSelectionIn(reverted, get().ui),
      ...libraryAt(get(), command?.library?.before),
    });
  },

  redo() {
    const history = useHistoryStore.getState();
    const command = history.peekRedo();
    const reapplied = history.redo(get().project);
    if (!reapplied) return;
    set({
      project: reapplied,
      ui: keepSelectionIn(reapplied, get().ui),
      ...libraryAt(get(), command?.library?.after),
    });
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
    if (!playing && get().ui.playbackRate !== 1) get().setUi({ playbackRate: 1 });
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

  markIn(frame) {
    const { ui, project } = get();
    get().setUi(withInPoint({ inFrame: ui.inFrame, outFrame: ui.outFrame }, frame ?? project.currentFrame));
  },

  markOut(frame) {
    const { ui, project } = get();
    get().setUi(withOutPoint({ inFrame: ui.inFrame, outFrame: ui.outFrame }, frame ?? project.currentFrame));
  },

  clearMarks() {
    get().setUi({ inFrame: null, outFrame: null });
  },

  setPlaybackRate(rate) {
    const clamped = Math.max(-8, Math.min(8, rate));
    // Stopping is a rate of zero, so K is the same action as L and J.
    get().setUi({ playbackRate: clamped === 0 ? 1 : clamped, isPlaying: clamped !== 0 });
  },

  insertSelectedAsset() {
    const plan = threePointPlan(get());
    if (!plan) return;
    const trackId = plan.placement.trackId;
    if (!trackId) {
      // No track of that kind yet: let the drop path make one.
      get().placeAssets([plan.asset], [{ ...plan.placement, startFrame: plan.start, durationFrames: plan.length }]);
      get().setCurrentFrame(plan.start + plan.length);
      return;
    }

    let placed: string | null = null;
    get().transact('Insert', (project) => {
      const clips = { ...project.clips };

      // Cut whatever is under the point, so the insert lands exactly there
      // rather than before the clip it fell inside.
      const straddling = Object.values(clips).find(
        (clip) => clip.trackId === trackId && clip.startFrame < plan.start && clipEndFrame(clip) > plan.start,
      );
      if (straddling) {
        const halves = splitClip(straddling, plan.start);
        if (halves) {
          clips[halves[0].id] = halves[0];
          clips[halves[1].id] = halves[1];
        }
      }

      // Everything from the point on moves along by the length going in.
      // Only this track: the others keep their timing, which is what makes
      // an insert on an overlay track safe.
      for (const clip of Object.values(clips)) {
        if (clip.trackId === trackId && clip.startFrame >= plan.start) {
          clips[clip.id] = moveClip(clip, clip.startFrame + plan.length);
        }
      }

      const clip = createClip({
        trackId,
        name: plan.asset.name,
        sourceUri: plan.asset.uri,
        startFrame: plan.start,
        durationFrames: plan.length,
        hasAlphaChannel: plan.asset.hasAlphaChannel,
        ...placedWhole(plan.asset, project),
      });
      placed = clip.id;
      clips[clip.id] = clip;
      return { ...project, clips };
    });

    if (placed) get().setUi({ selectedClipIds: [placed], selectedTrackId: trackId });
    get().setCurrentFrame(plan.start + plan.length);
  },

  overwriteSelectedAsset() {
    const plan = threePointPlan(get());
    if (!plan) return;
    const trackId = plan.placement.trackId;
    if (!trackId) {
      // No track of that kind yet, so there is nothing to overwrite.
      get().insertSelectedAsset();
      return;
    }

    let placed: string | null = null;
    get().transact('Overwrite', (project) => {
      const cleared = clearRange(project.clips, trackId, plan.start, plan.start + plan.length);
      const clip = createClip({
        trackId,
        name: plan.asset.name,
        sourceUri: plan.asset.uri,
        startFrame: plan.start,
        durationFrames: plan.length,
        hasAlphaChannel: plan.asset.hasAlphaChannel,
        ...placedWhole(plan.asset, project),
      });
      placed = clip.id;
      return { ...project, clips: { ...cleared.clips, [clip.id]: clip } };
    });

    if (placed) get().setUi({ selectedClipIds: [placed], selectedTrackId: trackId });
    get().setCurrentFrame(plan.start + plan.length);
  },

  setTool(tool) {
    set({ ui: { ...get().ui, tool } });
  },

  selectClips(clipIds, additive = false, exact = false) {
    const current = get().ui.selectedClipIds;
    const asked = exact ? clipIds : expandSelection(get().project.clips, clipIds);
    const next = additive ? [...new Set([...current, ...asked])] : asked;
    set({ ui: { ...get().ui, selectedClipIds: next, selectedTransitionId: next.length > 0 ? null : get().ui.selectedTransitionId } });
  },

  linkSelection() {
    const ids = get().ui.selectedClipIds.filter((id) => get().project.clips[id]);
    if (ids.length < 2) return;
    get().transact('Link clips', (project) => ({ ...project, clips: linkClips(project.clips, ids) }));
    // The group is now the selection, however it was picked.
    get().selectClips(ids);
  },

  unlinkSelection() {
    const { project, ui } = get();
    const ids = ui.selectedClipIds.filter((id) => project.clips[id]);
    if (!ids.some((id) => project.clips[id].linkGroup)) return;
    get().transact('Unlink clips', (current) => ({ ...current, clips: unlinkClips(current.clips, ids) }));
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
      // At the project's rate now, not the one it had when this was imported.
      durationFrames: assetLengthFrames(asset, get().project.fps),
      hasAlphaChannel: asset.hasAlphaChannel,
      ...placedWhole(asset, get().project),
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
          ...placedWhole(asset, project),
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

  addTitle(preset, at) {
    const { project } = get();
    const duration = Math.max(1, Math.round(TITLE_SECONDS * project.fps));
    const placement = at
      ? titleDropPlacement(project, at.trackId, at.startFrame, duration)
      : planTitlePlacement(project, project.currentFrame, duration);
    // Written in the language on screen; from then on it is the user's text.
    const text = translateNow(TITLE_TEXT[preset]);
    const fallbackName = translateNow(TITLE_NAME[preset]);
    let createdId = '';

    get().transact('Add title', (current) => {
      let rows = timelineRows(current.tracks);
      let trackId = placement.trackId;
      if (!trackId) {
        const track = createTrack('video', 0, nextTrackName(rows, 'video'));
        rows = [...rows];
        rows.splice(insertionRow(rows, 'video'), 0, track);
        trackId = track.id;
      }
      const clip = createTitleClip(preset, text, trackId, placement.startFrame, placement.durationFrames, fallbackName);
      createdId = clip.id;
      return { ...current, tracks: withRowOrders(rows), clips: { ...current.clips, [clip.id]: clip } };
    });

    set({ ui: { ...get().ui, selectedClipIds: [createdId], selectedTrackId: get().project.clips[createdId]?.trackId ?? null } });
    get().revealFrames(placement.startFrame, placement.startFrame + placement.durationFrames);
    return createdId;
  },

  updateTitle(clipId, patch, mergeKey) {
    get().transact(
      'Edit title',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip?.title) return project;
        const preset = patch.preset ?? clip.title.preset;
        const text = patch.text ?? clip.title.text;
        const style = normalizeTitleStyle({ ...clip.title.style, ...patch.style }, preset);
        const animation = patch.animation ? normalizeAnimation({ ...(clip.title.animation ?? NO_ANIMATION), ...patch.animation }) : clip.title.animation;
        const origin = patch.origin ?? clip.title.origin;
        const title: TitleContent = { preset, text, style, ...(animation ? { animation } : {}), ...(origin ? { origin } : {}) };
        const name = titleName(text, translateNow(TITLE_NAME[preset]));
        return { ...project, clips: { ...project.clips, [clipId]: { ...clip, name, title } } };
      },
      mergeKey,
    );
  },

  setTitleTextLive(clipId, text) {
    const { project } = get();
    const clip = project.clips[clipId];
    if (!clip?.title || clip.title.text === text) return;
    const name = titleName(text, translateNow(TITLE_NAME[clip.title.preset]));
    set({ project: { ...project, clips: { ...project.clips, [clipId]: { ...clip, name, title: { ...clip.title, text } } } } });
  },

  addTransitions(preset = 'crossDissolve', explicit) {
    const state = get();
    const { project, ui } = state;
    // The length chosen in Preferences (one second unless changed).
    const durationFrames = newTransitionFrames(project.fps, MIN_TRANSITION_FRAMES);
    const visual = new Set(project.tracks.filter((track) => track.type !== 'audio' && track.type !== 'captions').map((track) => track.id));
    let cuts: Array<{ fromId: string; toId: string }> = [];
    const fades: PendingTransition['fades'] = [];

    if (explicit) {
      cuts = explicit;
    } else {
      const selected = ui.selectedClipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip) && visual.has(clip.trackId));
      if (selected.length > 0) {
        // Both ends of each clip, as Final Cut's Command-T does: a cut where
        // there is a neighbour, a fade where there is not.
        for (const clip of selected) {
          const before = neighbourBefore(project.clips, clip);
          const after = neighbourAfter(project.clips, clip);
          if (before) cuts.push({ fromId: before.id, toId: clip.id });
          else fades.push({ clipId: clip.id, edge: 'in' });
          if (after) cuts.push({ fromId: clip.id, toId: after.id });
          else fades.push({ clipId: clip.id, edge: 'out' });
        }
      } else {
        const cut = cutNearPlayhead(project, ui.selectedTrackId);
        if (cut) cuts.push(cut);
      }
    }

    // Once each, and never on a cut that already has one.
    const taken = new Set(transitionsOf(project).map((transition) => `${transition.fromClipId}>${transition.toClipId}`));
    cuts = cuts.filter((cut) => {
      const key = `${cut.fromId}>${cut.toId}`;
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    });
    if (cuts.length === 0 && fades.length === 0) return;

    // What is short, and what an overlap would do - worked out on a copy.
    const lengthOf = (clip: Clip): number | undefined => sourceFramesFor(get(), clip);
    const short: PendingTransition['short'] = [];
    const leftBehind = new Set<string>();
    let overlapFrames = 0;
    let clips = project.clips;
    for (const cut of cuts) {
      const from = clips[cut.fromId];
      const to = clips[cut.toId];
      if (!from || !to) continue;
      const tail = tailHandle(from, lengthOf(from));
      const head = headHandle(to, lengthOf(to));
      const plan = planTransition(tail, head, durationFrames);
      if (plan.shortTail === 0 && plan.shortHead === 0) continue;
      short.push({ fromName: from.name, toName: to.name, tail, head, shortTail: plan.shortTail, shortHead: plan.shortHead });
      const overlap = overlapClips(clips, from, to, plan.shortTail, plan.shortHead);
      overlapFrames += overlap.shift;
      for (const clip of overlap.leftBehind) leftBehind.add(clip.name);
      clips = overlap.clips;
    }

    const request: PendingTransition = { preset, durationFrames, cuts, fades, short, overlapFrames, leftBehind: [...leftBehind] };
    // Not enough footage: ask, every time, as Final Cut and Resolve do.
    if (short.length > 0) {
      set({ ui: { ...get().ui, pendingTransition: request } });
      return;
    }
    applyTransitions(request, 'freeze');
  },

  dropTransition(preset, cut) {
    const existing = Object.values(get().project.transitions ?? {}).find(
      (transition) => transition.fromClipId === cut.fromId && transition.toClipId === cut.toId,
    );
    if (!existing) {
      get().addTransitions(preset, [cut]);
      return;
    }
    const { kind, color, direction } = presetKind(preset);
    get().updateTransition(existing.id, { kind, color, direction });
    get().selectTransition(existing.id);
  },

  resolvePendingTransition(choice) {
    const request = get().ui.pendingTransition;
    set({ ui: { ...get().ui, pendingTransition: null } });
    if (!request || choice === 'cancel') return;
    applyTransitions(request, choice);
  },

  updateTransition(transitionId, patch, mergeKey) {
    get().transact(
      'Edit transition',
      (project) => {
        const transition = project.transitions?.[transitionId];
        if (!transition) return project;
        const next = { ...transition, ...patch };
        next.durationFrames = Math.max(MIN_TRANSITION_FRAMES, Math.round(next.durationFrames));
        return { ...project, transitions: { ...project.transitions, [transitionId]: next } };
      },
      mergeKey,
    );
  },

  removeTransition(transitionId) {
    get().transact('Delete transition', (project) => {
      if (!project.transitions?.[transitionId]) return project;
      const { [transitionId]: _gone, ...rest } = project.transitions;
      void _gone;
      return { ...project, transitions: rest };
    });
    if (get().ui.selectedTransitionId === transitionId) set({ ui: { ...get().ui, selectedTransitionId: null } });
  },

  selectTransition(transitionId) {
    set({ ui: { ...get().ui, selectedTransitionId: transitionId, selectedClipIds: transitionId ? [] : get().ui.selectedClipIds } });
  },

  commitTitleText(clipId, fromText) {
    const clip = get().project.clips[clipId];
    if (!clip?.title || clip.title.text === fromText) return;
    const typed = clip.title.text;
    // Back to where the typing began, quietly, then the whole of it as one edit.
    get().setTitleTextLive(clipId, fromText);
    get().updateTitle(clipId, { text: typed });
  },

  addCaptionTrack(source, settings) {
    let trackId = '';
    get().transact('Add captions', (current) => {
      const rows = timelineRows(current.tracks);
      const track = captionTrack(createTrack('captions', 0, nextTrackName(current.tracks, 'captions')), settings.preset, settings.language);
      trackId = track.id;
      rows.splice(insertionRow(rows, 'captions'), 0, track);
      const made =
        'cues' in source
          ? cuesToClips(source.cues, track.id, current.fps, source.offsetFrame)
          : subtitleCuesToClips(source.subtitles, track.id, current.fps);
      const clips = { ...current.clips };
      for (const clip of made) clips[clip.id] = clip;
      const placed = { ...current, tracks: withRowOrders(rows), clips };
      // Transcribed captions are tied to the footage they were heard in, so
      // they follow it from now on. Captions read from a file are not: nothing
      // says they belong to what happens to be under them.
      if (!('cues' in source)) return placed;
      return linkCaptions(placed, made.map((clip) => clip.id), soundOfAssets(get().assets), source.sourceTrackId ?? null);
    });
    set({ ui: { ...get().ui, selectedTrackId: trackId } });
    return trackId;
  },

  setCaptionText(clipId, typed, mergeKey, manual) {
    get().transact(
      'Edit caption',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip?.caption) return project;
        const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
        const settings = captionSettingsOf(track);
        const keep = manual === true || clip.caption.manualBreaks === true;
        const text = keep ? typed : reflowText(typed, rulesFor(settings.preset, project), settings.language);
        if (clip.caption.text === text && Boolean(clip.caption.manualBreaks) === keep) return project;
        const { manualBreaks: _was, ...content } = clip.caption;
        void _was;
        return {
          ...project,
          clips: { ...project.clips, [clipId]: { ...clip, name: captionName(text), caption: { ...content, text, ...(keep ? { manualBreaks: true } : {}) } } },
        };
      },
      mergeKey,
    );
  },

  setCaptionBreaks(clipId, manual) {
    get().transact('Caption line breaks', (project) => {
      const clip = project.clips[clipId];
      if (!clip?.caption || Boolean(clip.caption.manualBreaks) === manual) return project;
      const settings = captionSettingsOf(project.tracks.find((candidate) => candidate.id === clip.trackId));
      const { manualBreaks: _was, ...content } = clip.caption;
      void _was;
      const text = manual ? content.text : reflowText(content.text.replace(/\s+/g, ' ').trim(), rulesFor(settings.preset, project), settings.language);
      return {
        ...project,
        clips: { ...project.clips, [clipId]: { ...clip, name: captionName(text), caption: { ...content, text, ...(manual ? { manualBreaks: true } : {}) } } },
      };
    });
  },

  mergeCaptions(clipId, direction) {
    const { project } = get();
    const clip = project.clips[clipId];
    if (!clip?.caption) return null;
    const row = Object.values(project.clips)
      .filter((other) => other.trackId === clip.trackId && other.caption)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    const at = row.findIndex((other) => other.id === clipId);
    const first = direction === 'next' ? clip : row[at - 1];
    const second = direction === 'next' ? row[at + 1] : clip;
    if (!first || !second) return null;
    const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
    if (track?.locked) return null;
    const settings = captionSettingsOf(track);

    get().transact('Merge captions', (current) => {
      const a = current.clips[first.id];
      const b = current.clips[second.id];
      if (!a || !b) return current;
      const { [b.id]: _gone, ...clips } = current.clips;
      void _gone;
      clips[a.id] = mergeCaptionClips(a, b, current.fps, settings, current);
      return { ...current, clips };
    });
    set({ ui: { ...get().ui, selectedClipIds: [first.id] } });
    return first.id;
  },

  fixCaptionTiming(trackId, clipIds) {
    const { project } = get();
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.type !== 'captions' || track.locked) return 0;
    const settings = captionSettingsOf(track);
    const row = Object.values(project.clips).filter((clip) => clip.trackId === trackId && clip.caption);
    const ends = fixTiming(
      row.map((clip) => ({ id: clip.id, startFrame: clip.startFrame, endFrame: clip.startFrame + clip.durationFrames, text: clip.caption?.text ?? '' })),
      rulesFor(settings.preset, project),
      project.fps,
    );
    const wanted = clipIds ? new Set(clipIds) : null;
    const changes = [...ends].filter(([id]) => !wanted || wanted.has(id));
    if (changes.length === 0) return 0;
    get().transact('Fix caption timing', (current) => {
      const clips = { ...current.clips };
      for (const [id, endFrame] of changes) {
        const clip = clips[id];
        if (clip) clips[id] = { ...clip, durationFrames: Math.max(1, endFrame - clip.startFrame) };
      }
      return { ...current, clips };
    });
    return changes.length;
  },

  replaceInCaptions(trackId, query, replacement, options = {}) {
    const { project } = get();
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.type !== 'captions' || track.locked) return 0;
    const settings = captionSettingsOf(track);
    const rules = rulesFor(settings.preset, project);
    let count = 0;
    const changed: Record<string, Clip> = {};
    for (const clip of Object.values(project.clips)) {
      if (clip.trackId !== trackId || !clip.caption) continue;
      if (options.only && options.only.clipId !== clip.id) continue;
      const result = replaceInText(clip.caption.text, query, replacement, { matchCase: options.matchCase, ...(options.only ? { occurrence: options.only.occurrence } : {}) });
      if (result.count === 0) continue;
      count += result.count;
      // Laid out again, unless its breaks are its author's.
      const text = clip.caption.manualBreaks ? result.text : reflowText(result.text.replace(/\s+/g, ' ').trim(), rules, settings.language);
      changed[clip.id] = { ...clip, name: captionName(text), caption: { ...clip.caption, text } };
    }
    if (count === 0) return 0;
    get().transact('Replace in captions', (current) => ({ ...current, clips: { ...current.clips, ...changed } }));
    return count;
  },

  setCaptionLook(trackId, patch, mergeKey) {
    get().transact(
      'Caption style',
      (project) => {
        const track = project.tracks.find((candidate) => candidate.id === trackId);
        if (!track || track.type !== 'captions') return project;
        const settings = captionSettingsOf(track);
        const { look: _was, ...plain } = settings;
        void _was;
        const next: CaptionTrackSettings =
          patch === null
            ? plain
            : {
                ...plain,
                look: normalizeLook(
                  {
                    ...lookOf(settings),
                    ...patch,
                    outline: { ...lookOf(settings).outline, ...patch.outline },
                    box: { ...lookOf(settings).box, ...patch.box },
                  },
                  settings.preset,
                ),
              };
        if (JSON.stringify(next) === JSON.stringify(track.captions)) return project;
        return { ...project, tracks: project.tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, captions: next } : candidate)) };
      },
      mergeKey,
    );
  },

  setCaptionPreset(trackId, preset) {
    get().transact('Caption preset', (project) => {
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.type !== 'captions') return project;
      const settings = captionSettingsOf(track);
      if (settings.preset === preset && !settings.look) return project;
      // A preset is its rules and its look: choosing one starts from both.
      // How the words move is not part of it, and stays.
      const captions: CaptionTrackSettings = { preset, language: settings.language, ...(settings.animation ? { animation: settings.animation } : {}) };
      return { ...project, tracks: project.tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, captions } : candidate)) };
    });
  },

  setCaptionAnimation(trackId, animation, mergeKey) {
    get().transact(
      'Caption animation',
      (project) => {
        const track = project.tracks.find((candidate) => candidate.id === trackId);
        if (!track || track.type !== 'captions') return project;
        const { animation: _was, ...settings } = captionSettingsOf(track);
        void _was;
        const next = animation ? normalizeCaptionAnimation(animation) : null;
        const captions: CaptionTrackSettings = { ...settings, ...(next ? { animation: next } : {}) };
        if (JSON.stringify(captions) === JSON.stringify(captionSettingsOf(track))) return project;
        return { ...project, tracks: project.tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, captions } : candidate)) };
      },
      mergeKey,
    );
  },

  setCaptionLanguage(trackId, language) {
    get().transact('Caption language', (project) => {
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.type !== 'captions') return project;
      const settings = captionSettingsOf(track);
      if (settings.language === language) return project;
      return { ...project, tracks: project.tracks.map((candidate) => (candidate.id === trackId ? { ...candidate, captions: { ...settings, language } } : candidate)) };
    });
  },

  addEmptyCaptionTrack(settings) {
    let trackId = '';
    get().transact('Add captions track', (current) => {
      const rows = timelineRows(current.tracks);
      const track = captionTrack(createTrack('captions', 0, nextTrackName(current.tracks, 'captions')), settings.preset, settings.language);
      trackId = track.id;
      rows.splice(insertionRow(rows, 'captions'), 0, track);
      return { ...current, tracks: withRowOrders(rows) };
    });
    set({ ui: { ...get().ui, selectedTrackId: trackId } });
    return trackId;
  },

  addCaptionAt(trackId, frame, text) {
    const { project } = get();
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.type !== 'captions' || track.locked) return null;
    const row = Object.values(project.clips).filter((clip) => clip.trackId === trackId && clip.caption);
    const at = Math.max(0, Math.round(frame));
    if (row.some((clip) => at >= clip.startFrame && at < clip.startFrame + clip.durationFrames)) return null;
    // Up to three seconds, and never into the next caption.
    const next = Math.min(Infinity, ...row.filter((clip) => clip.startFrame > at).map((clip) => clip.startFrame));
    const end = Math.min(at + Math.round(project.fps * 3), next);
    if (end <= at) return null;
    const clip = createCaptionClip(trackId, at, end, text);
    get().transact('Add caption', (current) => ({ ...current, clips: { ...current.clips, [clip.id]: clip } }));
    set({ ui: { ...get().ui, selectedClipIds: [clip.id] } });
    return clip.id;
  },

  setGlossary(terms) {
    get().transact('Glossary', (project) => {
      const glossary = normalizeGlossary(terms);
      if (JSON.stringify(glossary) === JSON.stringify(project.glossary ?? [])) return project;
      if (glossary.length === 0) {
        const { glossary: _gone, ...rest } = project;
        void _gone;
        return rest;
      }
      return { ...project, glossary };
    });
  },

  linkCaptionsToClips(clipIds) {
    const before = get().project;
    get().transact('Link captions', (project) => linkCaptions(project, clipIds, soundOfAssets(get().assets)));
    const after = get().project;
    return clipIds.filter((id) => after.clips[id]?.caption?.link && !before.clips[id]?.caption?.link).length;
  },

  unlinkCaptionsFromClips(clipIds) {
    get().transact('Unlink captions', (project) => unlinkCaptions(project, clipIds));
  },

  removeClips(clipIds) {
    if (clipIds.length === 0) return;
    const doomed = new Set(clipIds);

    const ripple = get().ui.rippleEnabled;
    get().transact('Delete clip', (project) => {
      const clips = Object.fromEntries(Object.entries(project.clips).filter(([id]) => !doomed.has(id)));
      // The magnet: what came after a deleted clip closes up behind it.
      // Not on a captions track: closing the hole a deleted caption leaves
      // would pull every later caption away from its words.
      if (ripple) {
        const closing = new Set([...doomed].filter((id) => !project.clips[id]?.caption));
        for (const [id, start] of rippleDelete(project.clips, closing)) if (clips[id]) clips[id] = moveClip(clips[id], start);
      }
      // Deleting one half of a pair leaves the other linked to nothing.
      return { ...project, clips: tidyLinkGroups(clips) };
    });
    set({ ui: { ...get().ui, selectedClipIds: [] } });
  },

  copySelection() {
    const { project, ui } = get();
    const content = copyClips(project, ui.selectedClipIds);
    if (content) set({ clipboard: content });
  },

  copyGrade(clipId) {
    const { project, ui } = get();
    const clip = project.clips[clipId ?? ui.selectedClipIds[0] ?? ''];
    if (!clip) return;
    // A copy, so later edits to the clip do not reach the clipboard. The
    // whole grade, LUT included, as Resolve copies a grade.
    set({ gradeClipboard: structuredClone(clip.colorGrading) });
  },

  pasteGrade(clipIds) {
    const { gradeClipboard, ui } = get();
    if (!gradeClipboard) return;
    const targets = clipIds ?? ui.selectedClipIds;
    get().transact('Paste grade', (project) => {
      const audio = new Set(project.tracks.filter((track) => track.type === 'audio').map((track) => track.id));
      const clips = { ...project.clips };
      let changed = false;
      for (const id of targets) {
        const clip = clips[id];
        if (!clip || audio.has(clip.trackId)) continue;
        clips[id] = { ...clip, colorGrading: structuredClone(gradeClipboard) };
        changed = true;
      }
      return changed ? { ...project, clips } : project;
    });
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

      const linked = regroupCopies(copies);
      for (const copy of linked) clips[copy.id] = copy;
      copies.splice(0, copies.length, ...linked);

      return { ...project, clips };
    });

    set({ ui: { ...get().ui, selectedClipIds: copies.map((clip) => clip.id) } });
  },

  moveClipTo(clipId, trackId, startFrame, base) {
    const { project, ui, assets } = get();
    const clip = project.clips[clipId];
    if (!clip) return;
    // A caption moves in time only, between its neighbours (planCaptionMove).
    if (clip.caption) {
      get().moveClipGroup([clipId], Math.round(startFrame) - (base?.[clipId] ?? clip).startFrame, 0, { base, mergeKey: `move:${clipId}` });
      return;
    }

    // Sound stays on audio tracks and pictures on picture tracks; a drag onto
    // the wrong kind keeps the clip on its own track and only moves it in time.
    const target = project.tracks.find((track) => track.id === trackId);
    // A title has no asset, but it is a picture: it stays off audio tracks.
    const kind = clipKind(clip, (uri) => assets.find((asset) => asset.uri === uri)?.kind);
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
          // Linked captions are not put back: they follow their clips from where they are.
          for (const [id, original] of Object.entries(base)) if (id !== clipId && clips[id] && !original.caption?.link) clips[id] = original;
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

  moveClipGroup(clipIds, deltaFrames, deltaTracks, options = {}) {
    const state = get();
    const from = options.base ?? state.project.clips;
    const rules = groupMoveOptions(state, options.anchorId);
    const plan = planGroupMove(from, clipIds, deltaFrames, deltaTracks, {
      ...rules,
      ripple: options.ripple ?? rules.ripple,
    });
    if (plan.size === 0 && !options.base) return;

    get().transact(
      'Move clips',
      (current) => {
        const clips = { ...current.clips };
        // Clips pushed aside earlier in the same drag go back first.
        if (options.base) {
          // Linked captions that are not themselves being moved are not put
          // back: they follow their clips from where they are.
          const moving = new Set(clipIds);
          for (const [id, original] of Object.entries(options.base)) {
            if (clips[id] && (moving.has(id) || !original.caption?.link)) clips[id] = original;
          }
        }
        for (const [id, placement] of plan) {
          const clip = clips[id];
          // moveClip, not a bare write: keyframes travel with their clip.
          if (clip) clips[id] = moveClip(clip, placement.startFrame, placement.trackId);
        }
        return { ...current, clips };
      },
      options.mergeKey,
    );
  },

  nudgeSelection(frames, tracks, repeat = false) {
    const state = get();
    const ids = state.ui.selectedClipIds.filter((id) => state.project.clips[id]);
    if (ids.length === 0 || (frames === 0 && tracks === 0)) return;
    const mergeKey = repeat ? `nudge:${ids.join(',')}` : undefined;

    if (tracks !== 0) {
      state.moveClipGroup(ids, 0, tracks, { mergeKey });
      return;
    }

    // In free space: exactly the frames asked for, and without closing the
    // hole behind - or a one-frame nudge would drag the rest of the track.
    const step = planGroupMove(state.project.clips, ids, frames, 0, { ...groupMoveOptions(state), ripple: false });
    const moves = ids.some((id) => step.has(id));
    const pushesOthers = [...step.keys()].some((id) => !ids.includes(id));
    if (moves && !pushesOthers) {
      state.moveClipGroup(ids, frames, 0, { mergeKey, ripple: false });
      return;
    }

    // A neighbour is in the way: hop over it.
    const hop = nudgeHopDelta(state.project.clips, ids, frames > 0 ? 1 : -1, state.ui.rippleEnabled);
    if (hop !== null) state.moveClipGroup(ids, hop, 0, { mergeKey });
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
    // Never on a caption: the captions after it stay with their words.
    const rippleEnd = edge === 'end' && ui.rippleEnabled && !clip.caption;

    // Otherwise an edge stops at its neighbour: a trimmed clip never grows
    // over the next one on its track (point 8 - clips never overlap).
    if (!rippleEnd) {
      const limit = trimLimit(project.clips, clip, edge);
      snapped = edge === 'start' ? Math.max(snapped, limit) : Math.min(snapped, limit);
    }

    // Linked clips keep the same edges: the one with the least footage or
    // the closest neighbour decides how far the trim goes, so they do not
    // come back from a drag at different lengths.
    const partners = partnersOf(project.clips, clipId).filter((id) => id !== clipId);
    if (partners.length > 0) {
      const wanted = snapped - (edge === 'start' ? clip.startFrame : clipEndFrame(clip));
      const rooms = [clipId, ...partners].map((id) => {
        const member = project.clips[id];
        return clipTrimRoom(
          member,
          edge,
          trimLimit(project.clips, member, edge),
          timelineFramesFor(get(), member),
        );
      });
      const delta = sharedTrimDelta(rooms, wanted);
      snapped = (edge === 'start' ? clip.startFrame : clipEndFrame(clip)) + delta;
    }

    get().transact(
      edge === 'start' ? 'Trim clip in' : 'Trim clip out',
      (current) => {
        const target = current.clips[clipId];
        if (!target) return current;
        const trimmed =
          edge === 'start' ? trimClipStart(target, snapped) : trimClipEnd(target, snapped);
        const clips = { ...current.clips, [clipId]: trimmed };

        // Every partner moves the same edge by the same number of frames.
        const moved = edge === 'start'
          ? trimmed.startFrame - target.startFrame
          : clipEndFrame(trimmed) - clipEndFrame(target);
        for (const id of partners) {
          const member = current.clips[id];
          if (!member || moved === 0) continue;
          clips[id] = edge === 'start'
            ? trimClipStart(member, member.startFrame + moved)
            : trimClipEnd(member, clipEndFrame(member) + moved);
        }

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
      .filter((pair): pair is [Clip, Clip] => pair !== null)
      // A caption's words go to the side of the cut they were spoken on.
      .map(([left, right]): [Clip, Clip] =>
        left.caption
          ? splitCaption(left, right, cutFrame, project.fps, captionSettingsOf(project.tracks.find((track) => track.id === left.trackId)), project)
          : [left, right],
      );

    if (splits.length === 0) return;

    get().transact('Split clip', (current) => {
      const clips = { ...current.clips };
      // The halves to the right of the cut are linked to each other from
      // here on, not to the halves on the left: cutting a linked pair gives
      // two pairs, the way Premiere cuts one.
      const rights = regroupCopies(splits.map(([, right]) => right));
      splits.forEach(([left], index) => {
        clips[left.id] = left;
        clips[rights[index].id] = rights[index];
      });
      return { ...current, clips: tidyLinkGroups(clips) };
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

  setTransformAt(clipId, frame, patch) {
    get().transact(
      'Transform',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;

        // A property with one keyframe or none is a fixed value, and a drag
        // changes it in place. Writing a second keyframe at the playhead
        // instead would quietly animate the clip from its old size to the new
        // one - a photo placed fitted, then resized half-way through, would
        // grow across its whole length. Only an animation already there (two
        // keyframes or more) is edited at the playhead.
        const place = <T extends Vector2D | number>(track: Keyframe<T>[], value: T): Keyframe<T>[] =>
          track.length === 1 ? [{ ...track[0], value }] : upsertKeyframe(track, frame, value);
        const transform = { ...clip.transform };
        if (patch.position) transform.position = place(transform.position, { ...patch.position });
        if (patch.scale) transform.scale = place(transform.scale, { ...patch.scale });
        if (patch.rotation !== undefined) transform.rotation = place(transform.rotation, patch.rotation);

        return { ...project, clips: { ...project.clips, [clipId]: { ...clip, transform } } };
      },
      `kf:${clipId}:transform:${frame}`,
    );
  },

  setClipFade(clipId, edge, frames) {
    get().transact(
      edge === 'in' ? 'Fade in' : 'Fade out',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;
        const length = fadeFromDrag(clip, edge, frames);
        return {
          ...project,
          clips: {
            ...project.clips,
            [clipId]: edge === 'in'
              ? { ...clip, fadeInFrames: length }
              : { ...clip, fadeOutFrames: length },
          },
        };
      },
      `fade:${clipId}:${edge}`,
    );
  },

  setClipSpeed(clipId, { speed, reversed, ripple }) {
    const source = sourceFramesFor(get(), get().project.clips[clipId]);
    get().transact(
      'Change speed',
      (project) => {
        const clip = project.clips[clipId];
        if (!clip) return project;

        const next = retimed(clip, { speed, reversed }, source);
        const delta = next.durationFrames - clip.durationFrames;
        const clips = { ...project.clips, [clipId]: next };

        if (delta === 0) return { ...project, clips };

        if (ripple) {
          // Everything that starts after this clip ended moves by what the
          // clip gained or lost.
          const wasEnd = clip.startFrame + clip.durationFrames;
          for (const other of Object.values(project.clips)) {
            if (other.id === clipId || other.trackId !== clip.trackId) continue;
            if (other.startFrame < wasEnd) continue;
            clips[other.id] = moveClip(other, Math.max(0, other.startFrame + delta));
          }
          return { ...project, clips };
        }

        // No ripple: a clip that grew stops where its neighbour begins,
        // because clips on a track never overlap.
        const limit = trimLimit(project.clips, clip, 'end');
        const capped = Math.max(1, Math.min(next.durationFrames, limit - clip.startFrame));
        clips[clipId] = { ...next, durationFrames: capped };
        return { ...project, clips };
      },
      `speed:${clipId}`,
    );
  },

  rippleTrimClip(clipId, edge, frame) {
    get().transact(
      'Ripple trim',
      (project) => ({
        ...project,
        clips: rippleTrim(project.clips, clipId, edge, frame, timelineFramesFor(get(), project.clips[clipId])),
      }),
      `ripple:${clipId}:${edge}`,
    );
  },

  rollEditAt(leftId, rightId, frame) {
    get().transact(
      'Roll edit',
      (project) => ({
        ...project,
        clips: rollEdit(project.clips, leftId, rightId, frame, {
          left: timelineFramesFor(get(), project.clips[leftId]),
          right: timelineFramesFor(get(), project.clips[rightId]),
        }),
      }),
      `roll:${leftId}:${rightId}`,
    );
  },

  slipClipBy(clipId, deltaFrames, base) {
    const from = base[clipId];
    if (!from) return;
    get().transact(
      'Slip',
      (project) => ({
        ...project,
        // Slipping a retimed clip moves the footage by what that drag is
        // worth in film: at 200%, a frame of timeline is two frames of it.
        clips: {
          ...project.clips,
          [clipId]: slipClip(from, deltaFrames * speedOf(from), timelineFramesFor(get(), from)),
        },
      }),
      `slip:${clipId}`,
    );
  },

  slideClipBy(clipId, deltaFrames, base) {
    const from = base[clipId];
    if (!from) return;
    get().transact(
      'Slide',
      (project) => {
        // From the clips as they were when the drag began, so dragging back
        // and forth does not stack up trims on the neighbours.
        const restored = { ...project.clips };
        for (const clip of Object.values(base)) {
          if (clip.trackId === from.trackId && restored[clip.id]) restored[clip.id] = clip;
        }
        return {
          ...project,
          clips: slideClip(restored, clipId, deltaFrames, {
            previous: timelineFramesFor(get(), neighbourBefore(restored, from)),
          }),
        };
      },
      `slide:${clipId}`,
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

  addAssets(assets, binId) {
    const existing = new Set(get().assets.map((asset) => asset.uri));
    // Imports land in the bin being looked at, the way the Media Pool files
    // them into the selected bin; a folder import brings its own.
    const target = binId === undefined ? get().currentBinId : binId;
    const fresh = assets
      .filter((asset) => !existing.has(asset.uri))
      .map((asset) => (asset.binId || !target ? asset : { ...asset, binId: target }));
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

  relinkAssets(changes) {
    const byId = new Map(changes.map((change) => [change.assetId, change]));
    const remap = new Map<string, string>();
    const assets = get().assets.map((asset) => {
      const change = byId.get(asset.id);
      if (!change) return asset;
      if (change.uri !== asset.uri) remap.set(asset.uri, change.uri);
      // The proxy and extracted audio of the old file are not this one's.
      const { proxyUri: _proxy, audioUri: _audio, ...rest } = asset;
      void _proxy;
      void _audio;
      return {
        ...rest,
        uri: change.uri,
        sourcePath: change.sourcePath,
        ...(change.audioUri ? { audioUri: change.audioUri } : {}),
        missing: false,
      };
    });
    // Usually the URL is kept (main/ipc/mediaProtocol.ts retargets it), so
    // clips and the undo history need nothing; a clip dropped in from a
    // browser session has no media:// URL to keep, and follows the new one.
    const project = remap.size > 0 ? remapClipSources(get().project, remap) : get().project;
    set({ assets, project });
  },

  setAssetProxy(assetId, proxyUri) {
    set({
      assets: get().assets.map((asset) => (asset.id === assetId ? { ...asset, proxyUri } : asset)),
    });
  },

  /* Media bins ----------------------------------------------------------- */

  setCurrentBin(binId) {
    set({ currentBinId: binId && get().bins.some((bin) => bin.id === binId) ? binId : null });
  },

  // Bin edits are undoable steps like timeline edits, in the same history,
  // so Ctrl+Z takes back whichever came last. Importing (and the bins a
  // folder import creates) is not, the same as importing a file.
  createBin(parentId, name) {
    const before = librarySnapshot(get().bins, get().assets);
    const created = createMediaBin(get().bins, parentId, name);
    set({ bins: created.bins });
    pushLibraryEdit('New bin', before, librarySnapshot(get().bins, get().assets));
    return created.bin.id;
  },

  renameBin(binId, name) {
    const before = librarySnapshot(get().bins, get().assets);
    set({ bins: renameMediaBin(get().bins, binId, name) });
    pushLibraryEdit('Rename bin', before, librarySnapshot(get().bins, get().assets));
  },

  deleteBin(binId) {
    const before = librarySnapshot(get().bins, get().assets);
    const parentId = get().bins.find((bin) => bin.id === binId)?.parentId ?? null;
    const next = deleteMediaBin(get().bins, get().assets, binId);
    // Looking at the bin being deleted would show nothing: follow its contents up.
    set({ ...next, currentBinId: get().currentBinId === binId ? parentId : get().currentBinId });
    pushLibraryEdit('Delete bin', before, librarySnapshot(get().bins, get().assets));
  },

  moveAssetsToBin(assetIds, binId) {
    const before = librarySnapshot(get().bins, get().assets);
    set({ assets: moveMediaAssets(get().assets, assetIds, binId) });
    pushLibraryEdit('Move to bin', before, librarySnapshot(get().bins, get().assets));
  },

  ensureBinPath(parentId, segments) {
    const result = ensureMediaBinPath(get().bins, parentId, segments);
    set({ bins: result.bins });
    return result.binId;
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

/**
 * A picture comes in whole, at its own shape: fitted inside the frame with
 * bars, not stretched to fill it. Sound has no shape.
 */
function placedWhole(
  asset: { kind: string; width: number; height: number },
  project: { width: number; height: number },
): { initialScale?: Vector2D } {
  if (asset.kind === 'audio') return {};
  const scale = fitScale(asset, project);
  return scale ? { initialScale: scale } : {};
}

/**
 * What a three-point edit would do: which clip, where, and how long.
 *
 * The marked range decides the length and the landing point; with nothing
 * marked it is the whole source, at the playhead.
 */
function threePointPlan(state: ProjectStore): {
  asset: MediaAsset;
  placement: DropPlacement;
  start: number;
  length: number;
} | null {
  const { project, ui, assets } = state;
  const asset = assets.find((candidate) => candidate.id === ui.selectedAssetId);
  if (!asset) return null;

  const start = ui.inFrame ?? project.currentFrame;
  const length = editLength(
    assetLengthFrames(asset, project.fps),
    rangeLength({ inFrame: ui.inFrame, outFrame: ui.outFrame }),
  );
  const [placement] = planDrop(project, [asset], ui.selectedTrackId, start);
  return placement ? { asset, placement, start, length } : null;
}

/**
 * How many frames of footage a clip has to draw on.
 *
 * A still has no end - it can be held for as long as anyone likes - so it
 * reports none, and the trims leave it unlimited.
 */
function sourceFramesFor(state: ProjectStore, clip: Clip | null | undefined): number | undefined {
  if (!clip) return undefined;
  const asset = state.assets.find((candidate) => candidate.uri === clip.sourceUri);
  if (!asset || asset.kind === 'image') return undefined;
  return assetLengthFrames(asset, state.project.fps);
}

/**
 * The same footage, counted in frames of the timeline.
 *
 * The trims measure room against a clip's duration, which is timeline
 * time; at 200% a clip spends two frames of film for each of those, so the
 * room it has is half. Without this a retimed clip could be trimmed past
 * the end of its own footage.
 */
function timelineFramesFor(state: ProjectStore, clip: Clip | null | undefined): number | undefined {
  const frames = sourceFramesFor(state, clip);
  if (frames === undefined || !clip) return undefined;
  return Math.max(1, Math.floor(frames / speedOf(clip)));
}

/**
 * Put a request's transitions (and fades) in, as one undo step. Where a cut
 * is short, `overlap` shortens the clips and closes the track up first;
 * `freeze` leaves them as they are, and the renderer holds their last and
 * first frames for what is missing.
 */
function applyTransitions(request: PendingTransition, choice: 'overlap' | 'freeze'): void {
  const store = useProjectStore.getState();
  const lengthOf = (clip: Clip): number | undefined => sourceFramesFor(useProjectStore.getState(), clip);
  let added: string | null = null;
  store.transact('Add transition', (project) => {
    let clips = project.clips;
    const transitions = { ...(project.transitions ?? {}) };
    for (const cut of request.cuts) {
      let from = clips[cut.fromId];
      let to = clips[cut.toId];
      // Still a cut: the same track, one ending where the other begins.
      if (!from || !to || from.trackId !== to.trackId || from.startFrame + from.durationFrames !== to.startFrame) continue;
      let plan = planTransition(tailHandle(from, lengthOf(from)), headHandle(to, lengthOf(to)), request.durationFrames);
      if ((plan.shortTail > 0 || plan.shortHead > 0) && choice === 'overlap') {
        clips = overlapClips(clips, from, to, plan.shortTail, plan.shortHead).clips;
        from = clips[cut.fromId];
        to = clips[cut.toId];
        plan = { alignment: 'center', shortTail: 0, shortHead: 0 };
      }
      const transition = createTransition(from, to, request.preset, request.durationFrames, plan.alignment);
      transitions[transition.id] = transition;
      added = transition.id;
    }
    if (request.fades.length > 0) {
      clips = { ...clips };
      for (const fade of request.fades) {
        const clip = clips[fade.clipId];
        if (!clip) continue;
        const length = fadeFromDrag(clip, fade.edge, request.durationFrames);
        clips[clip.id] = fade.edge === 'in' ? { ...clip, fadeInFrames: length } : { ...clip, fadeOutFrames: length };
      }
    }
    return { ...project, clips, transitions };
  });
  // One new transition is shown picked, ready for the inspector.
  if (added && request.cuts.length === 1 && request.fades.length === 0) useProjectStore.getState().selectTransition(added);
}

/** The clip that begins where `clip` ends, if one does. */
function neighbourAfter(clips: Record<string, Clip>, clip: Clip): Clip | null {
  const end = clip.startFrame + clip.durationFrames;
  return Object.values(clips).find((candidate) => candidate.trackId === clip.trackId && candidate.id !== clip.id && candidate.startFrame === end) ?? null;
}

/**
 * With nothing selected, Ctrl+T acts on the cut nearest the playhead - on the
 * selected track when there is one, else on any picture track - within a
 * second of it.
 */
function cutNearPlayhead(project: ProjectState, trackId: string | null): { fromId: string; toId: string } | null {
  const visual = new Set(project.tracks.filter((track) => track.type !== 'audio' && track.type !== 'captions').map((track) => track.id));
  let best: { fromId: string; toId: string; distance: number; preferred: boolean } | null = null;
  const reach = Math.max(1, Math.round(project.fps));
  for (const to of Object.values(project.clips)) {
    if (!visual.has(to.trackId)) continue;
    const from = neighbourBefore(project.clips, to);
    if (!from) continue;
    const distance = Math.abs(to.startFrame - project.currentFrame);
    if (distance > reach) continue;
    const preferred = to.trackId === trackId;
    if (!best || (preferred && !best.preferred) || (preferred === best.preferred && distance < best.distance)) {
      best = { fromId: from.id, toId: to.id, distance, preferred };
    }
  }
  return best ? { fromId: best.fromId, toId: best.toId } : null;
}

/** The clip that ends where `clip` begins, if one does. */
function neighbourBefore(clips: Record<string, Clip>, clip: Clip): Clip | null {
  return (
    Object.values(clips).find(
      (candidate) =>
        candidate.trackId === clip.trackId &&
        candidate.id !== clip.id &&
        candidate.startFrame + candidate.durationFrames === clip.startFrame,
    ) ?? null
  );
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

/** The rules a group move takes from the editor: magnet, track order, what each track accepts. */
function groupMoveOptions(
  state: { project: ProjectState; ui: { rippleEnabled: boolean }; assets: readonly MediaAsset[] },
  anchorId?: string,
): GroupMoveOptions {
  const kinds = new Map(state.assets.map((asset) => [asset.uri, asset.kind]));
  return {
    ripple: state.ui.rippleEnabled,
    tracks: timelineRows(state.project.tracks),
    accepts: (track, clip) => trackAccepts(track, clipKind(clip, (uri) => kinds.get(uri))),
    anchorId,
  };
}

/** The editor state with its selection narrowed to clips `project` still has. */
function keepSelectionIn<Ui extends { selectedClipIds: string[] }>(project: ProjectState, ui: Ui): Ui {
  const kept = ui.selectedClipIds.filter((id) => project.clips[id] !== undefined);
  return { ...ui, selectedClipIds: kept };
}
