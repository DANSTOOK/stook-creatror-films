import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowDown,
  Gauge,
  Link2,
  ArrowUp,
  Copy,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Crosshair,
  Eye,
  EyeOff,
  Flag,
  Hand,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  MousePointer2,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Clip, Marker, MediaAsset, Track } from '@shared/types';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { clipEndFrame, clipsInPaintOrder, clipsOnTrack, razorClick } from './timelineOps';
import { trimTargetAt, type TrimTarget } from './trimModes';
import { isLinked } from './linkGroups';
import { SpeedDialog } from './SpeedDialog';
import { collectSnapTargets, pixelToFrame, snapClipMove, snapFrame, type SnapTarget } from './snapping';
import { ASSET_DRAG_TYPE, planDrop } from './dropPlacement';
import { clipsInMarquee } from './marquee';
import { importDroppedFiles } from '@renderer/media/importMedia';
import { emitScrub } from '@renderer/audio/scrubAudio';
import { canMoveTrack, timelineRows } from './trackRows';
import TimelineCanvas, {
  type ClipHover,
  RULER_HEIGHT,
  TRACK_GAP,
  TRACK_HEIGHT,
  hitsPlayheadScissors,
  markerAtPixel,
  trackIndexAtY,
  trackRowTop,
} from './TimelineCanvas';

/** Width of the grab zone at each end of a clip, in pixels. */
const TRIM_HANDLE_PX = 6;
/** How near a fade grip a press counts as grabbing it. */
const FADE_GRIP_PX = 7;
/** The strip along the top of a clip where the fade grips live. */
const FADE_GRIP_ZONE_PX = 12;
const HEADER_WIDTH = 168;

type DragMode =
  | { kind: 'none' }
  | { kind: 'scrub' }
  /** Pressed the scissors on the playhead: a click cuts, a drag scrubs. */
  | { kind: 'scissors'; startClientX: number }
  | {
      kind: 'move';
      clipId: string;
      grabOffsetFrames: number;
      /** The clips when the drag began: clips pushed aside go back if passed. */
      base: Record<string, Clip>;
    }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end' }
  /** A fade grip in one of the clip's top corners. */
  | { kind: 'fade'; clipId: string; edge: 'in' | 'out' }
  /**
   * The trim tool: which trim was picked up, where the drag began, and the
   * clips as they were then - slip and slide are worked out from that start,
   * so dragging back and forth does not pile trims onto the neighbours.
   */
  | { kind: 'smartTrim'; target: TrimTarget; startFrame: number; base: Record<string, Clip> }
  | { kind: 'pan'; startClientX: number; startScrollLeft: number }
  | {
      /** Rubber band from an empty spot; a plain click still moves the playhead. */
      kind: 'marquee';
      /** Start in CONTENT space, so the band survives the view scrolling. */
      startContentX: number;
      startY: number;
      /** Selection to add to (Shift / Ctrl), or empty for a fresh one. */
      base: string[];
      additive: boolean;
      moved: boolean;
    }
  | {
      /** Several selected clips dragged together. */
      kind: 'group';
      anchorId: string;
      grabOffsetFrames: number;
      origins: Map<string, number>;
      /** The clips when the drag began; every move of the group is placed from these. */
      base: Record<string, Clip>;
      /** A click (no drag) on a clip inside a selection narrows to that clip. */
      collapseTo: string | null;
      /** Alt was held: narrow to that clip alone, linked partners and all. */
      collapseExact: boolean;
      moved: boolean;
    };

/** Pointer travel, in pixels, before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Multi-track timeline: track headers plus the canvas editing surface. */
export function Timeline(): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const waveforms = useMediaStore((state) => state.waveforms);
  const store = useProjectStore;

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [activeSnap, setActiveSnap] = useState<SnapTarget | null>(null);
  /** The clip whose Speed/Duration dialog is open, if any. */
  const [speedFor, setSpeedFor] = useState<string | null>(null);

  // Ctrl+R opens it for the selected clip, the key Resolve uses for its
  // Retime controls. Premiere puts this on the right-click menu only.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'r') return;
      const selected = store.getState().ui.selectedClipIds;
      if (selected.length !== 1) return;
      event.preventDefault();
      setSpeedFor(selected[0]);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store]);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [renamingMarkerId, setRenamingMarkerId] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [hover, setHover] = useState<ClipHover | null>(null);
  const [overScissors, setOverScissors] = useState(false);

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // Picture tracks on top, the topmost layer first; audio underneath.
  const tracks = timelineRows(project.tracks);
  const renamingMarker = project.markers.find((marker) => marker.id === renamingMarkerId);
  const contentWidth = Math.max(
    viewportWidth,
    (project.durationFrames + project.fps * 5) * ui.pixelsPerFrame,
  );
  const canvasHeight = RULER_HEIGHT + tracks.length * (TRACK_HEIGHT + TRACK_GAP) + 8;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
      // The store fits and reveals content, so it needs the width too.
      store.getState().setUi({ viewportWidthPx: entry.contentRect.width });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [store]);

  // Zoom and reveal set the scroll offset in the store; apply it to the
  // element. After layout, so a zoom-out that shrinks the content has already
  // shrunk it and the offset is not clamped against the old width.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && Math.abs(element.scrollLeft - ui.scrollLeftPx) > 1) {
      element.scrollLeft = ui.scrollLeftPx;
    }
  }, [ui.scrollLeftPx, ui.pixelsPerFrame]);

  // Ctrl+wheel zooms around the pointer, like every editor. Registered by hand
  // because React's onWheel is passive and cannot stop the page from scrolling.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = event.clientX - element.getBoundingClientRect().left;
      store.getState().zoomBy(event.deltaY < 0 ? 1.25 : 1 / 1.25, anchor);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [store]);

  // The canvas paints in scroll-space, so it needs the live scroll offset.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = (): void => {
      store.getState().setUi({ scrollLeftPx: element.scrollLeft });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [store]);

  const clipAtPoint = useCallback(
    (x: number, y: number): { clip: Clip; edge: 'start' | 'end' | null } | null => {
      const trackIndex = trackIndexAtY(y);
      const track = tracks[trackIndex];
      if (!track) return null;

      const frame = (x + ui.scrollLeftPx) / ui.pixelsPerFrame;

      // Topmost first: the reverse of the order the canvas paints in, so the
      // clip a click selects is the one that is visibly on top.
      const topmostFirst = clipsInPaintOrder(project, track.id, ui.selectedClipIds).reverse();
      for (const clip of topmostFirst) {
        if (frame < clip.startFrame || frame > clipEndFrame(clip)) continue;

        const startX = clip.startFrame * ui.pixelsPerFrame - ui.scrollLeftPx;
        const endX = clipEndFrame(clip) * ui.pixelsPerFrame - ui.scrollLeftPx;

        if (Math.abs(x - startX) <= TRIM_HANDLE_PX) return { clip, edge: 'start' };
        if (Math.abs(x - endX) <= TRIM_HANDLE_PX) return { clip, edge: 'end' };
        return { clip, edge: null };
      }
      return null;
    },
    [project, tracks, ui.pixelsPerFrame, ui.scrollLeftPx, ui.selectedClipIds],
  );

  /* Context menus -------------------------------------------------------- */

  const trackMenuItems = useCallback(
    (track: Track): ContextMenuItem[] => {
      const state = store.getState();
      const index = tracks.findIndex((candidate) => candidate.id === track.id);
      const clipCount = clipsOnTrack(state.project, track.id).length;

      return [
        {
          label: 'Rename track',
          icon: Pencil,
          onSelect: () => setRenamingTrackId(track.id),
        },
        { separator: true },
        {
          label: 'Add track above',
          icon: Plus,
          onSelect: () => state.addTrackAt(track.type, index),
        },
        {
          label: 'Add track below',
          icon: Plus,
          onSelect: () => state.addTrackAt(track.type, index + 1),
        },
        { separator: true },
        {
          label: 'Move up',
          icon: ArrowUp,
          // Within its group: a picture track never goes below the audio.
          disabled: !canMoveTrack(tracks, track.id, -1),
          onSelect: () => state.moveTrack(track.id, -1),
        },
        {
          label: 'Move down',
          icon: ArrowDown,
          disabled: !canMoveTrack(tracks, track.id, 1),
          onSelect: () => state.moveTrack(track.id, 1),
        },
        { separator: true },
        {
          label: track.visible ? 'Hide track' : 'Show track',
          icon: track.visible ? EyeOff : Eye,
          onSelect: () => state.updateTrack(track.id, { visible: !track.visible }),
        },
        {
          label: track.muted ? 'Unmute track' : 'Mute track',
          icon: track.muted ? Volume2 : VolumeX,
          onSelect: () => state.updateTrack(track.id, { muted: !track.muted }),
        },
        {
          label: track.locked ? 'Unlock track' : 'Lock track',
          icon: track.locked ? LockOpen : Lock,
          onSelect: () => state.updateTrack(track.id, { locked: !track.locked }),
        },
        { separator: true },
        {
          // Saying how much goes with it makes an undoable delete predictable.
          label: clipCount > 0 ? `Delete track (${clipCount} clips)` : 'Delete track',
          icon: Trash2,
          danger: true,
          disabled: tracks.length <= 1,
          onSelect: () => state.removeTrack(track.id),
        },
      ];
    },
    [store, tracks],
  );

  const clipMenuItems = useCallback(
    (clip: Clip, frame: number): ContextMenuItem[] => {
      const state = store.getState();
      const selected = state.ui.selectedClipIds.includes(clip.id)
        ? state.ui.selectedClipIds
        : [clip.id];

      const canSplit = frame > clip.startFrame && frame < clipEndFrame(clip);

      return [
        {
          label: 'Split at playhead',
          icon: Scissors,
          shortcut: 'B',
          disabled: !canSplit,
          onSelect: () => state.razorAtFrame(state.project.currentFrame, [clip.id]),
        },
        {
          label: 'Speed / Duration...',
          icon: Gauge,
          shortcut: 'Ctrl+R',
          onSelect: () => setSpeedFor(clip.id),
        },
        {
          label: selected.length > 1 ? `Duplicate ${selected.length} clips` : 'Duplicate',
          icon: Copy,
          onSelect: () => state.duplicateClips(selected),
        },
        { separator: true },
        {
          label: isLinked(state.project.clips, selected)
            ? 'Unlink clips'
            : `Link ${selected.length} clips`,
          icon: Link2,
          shortcut: isLinked(state.project.clips, selected) ? 'Ctrl+Shift+L' : 'Ctrl+L',
          disabled: selected.length < 2 && !clip.linkGroup,
          onSelect: () => {
            state.selectClips(selected);
            if (clip.linkGroup) state.unlinkSelection();
            else state.linkSelection();
          },
        },
        { separator: true },
        {
          label: 'Cut',
          icon: Scissors,
          shortcut: 'Ctrl+X',
          onSelect: () => {
            state.selectClips(selected);
            state.cutSelection();
          },
        },
        {
          label: 'Copy',
          icon: Copy,
          shortcut: 'Ctrl+C',
          onSelect: () => {
            state.selectClips(selected);
            state.copySelection();
          },
        },
        {
          label: 'Paste at playhead',
          icon: ClipboardPaste,
          shortcut: 'Ctrl+V',
          disabled: !state.clipboard,
          onSelect: () => state.paste(),
        },
        { separator: true },
        {
          label: clip.mask.enabled ? 'Disable mask' : 'Enable mask',
          onSelect: () =>
            state.updateClip(clip.id, { mask: { ...clip.mask, enabled: !clip.mask.enabled } }),
        },
        {
          label: clip.chromaKey.enabled ? 'Disable chroma key' : 'Enable chroma key',
          onSelect: () =>
            state.updateClip(clip.id, {
              chromaKey: { ...clip.chromaKey, enabled: !clip.chromaKey.enabled },
            }),
        },
        {
          label: clip.pixelArt.enabled ? 'Disable pixel art' : 'Enable pixel art',
          onSelect: () =>
            state.updateClip(clip.id, {
              pixelArt: { ...clip.pixelArt, enabled: !clip.pixelArt.enabled },
            }),
        },
        { separator: true },
        {
          label: selected.length > 1 ? `Delete ${selected.length} clips` : 'Delete clip',
          icon: Trash2,
          shortcut: 'Del',
          danger: true,
          onSelect: () => state.removeClips(selected),
        },
      ];
    },
    [store],
  );

  const emptyAreaMenuItems = useCallback((): ContextMenuItem[] => {
    const state = store.getState();
    // No "add text track": nothing renders text yet, so offering it would
    // create a track that can never show anything.
    return [
      { label: 'Add video track', icon: Plus, onSelect: () => state.addTrack('video') },
      { label: 'Add audio track', icon: Plus, onSelect: () => state.addTrack('audio') },
      { separator: true },
      {
        label: 'Split at playhead',
        icon: Scissors,
        shortcut: 'B',
        onSelect: () => state.razorAtFrame(),
      },
      {
        label: 'Paste at playhead',
        icon: ClipboardPaste,
        shortcut: 'Ctrl+V',
        disabled: !state.clipboard,
        onSelect: () => state.paste(),
      },
    ];
  }, [store]);

  /**
   * The ruler's own menu.
   *
   * Markers were drawable and snappable long before anything could create one,
   * which is the same as not having them. This is where they get created,
   * named and removed.
   */
  const rulerMenuItems = useCallback(
    (frame: number, marker: Marker | undefined): ContextMenuItem[] => {
      const state = store.getState();
      const markerCount = state.project.markers.length;

      if (marker) {
        return [
          {
            label: 'Rename marker',
            icon: Pencil,
            onSelect: () => {
              state.setUi({ selectedMarkerId: marker.id });
              setRenamingMarkerId(marker.id);
            },
          },
          {
            label: 'Move to playhead',
            icon: Flag,
            disabled: marker.frame === state.project.currentFrame,
            onSelect: () => state.updateMarker(marker.id, { frame: state.project.currentFrame }),
          },
          { separator: true },
          {
            label: 'Delete marker',
            icon: Trash2,
            danger: true,
            onSelect: () => state.removeMarker(marker.id),
          },
        ];
      }

      return [
        {
          label: 'Add marker here',
          icon: Flag,
          onSelect: () => {
            const id = state.addMarker(frame);
            if (id) setRenamingMarkerId(id);
          },
        },
        {
          label: 'Add marker at playhead',
          icon: Flag,
          shortcut: 'M',
          onSelect: () => {
            const id = state.addMarker();
            if (id) setRenamingMarkerId(id);
          },
        },
        { separator: true },
        {
          label: markerCount > 0 ? `Clear all markers (${markerCount})` : 'Clear all markers',
          icon: Trash2,
          danger: true,
          disabled: markerCount === 0,
          onSelect: () => state.clearMarkers(),
        },
      ];
    },
    [store],
  );

  const onCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;

      if (y < RULER_HEIGHT) {
        openMenu(
          event,
          rulerMenuItems(
            pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx),
            markerAtPixel(project, ui, x),
          ),
        );
        return;
      }

      const hit = clipAtPoint(x, y);
      if (hit) {
        // Right-clicking an unselected clip selects it first, so the menu acts
        // on what the user just pointed at.
        if (!ui.selectedClipIds.includes(hit.clip.id)) {
          store.getState().selectClips([hit.clip.id]);
        }
        openMenu(event, clipMenuItems(hit.clip, project.currentFrame));
        return;
      }

      openMenu(event, emptyAreaMenuItems());
    },
    [
      clipAtPoint,
      clipMenuItems,
      emptyAreaMenuItems,
      openMenu,
      project,
      rulerMenuItems,
      store,
      ui,
    ],
  );

  /* Pointer interaction -------------------------------------------------- */

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // The context menu handler owns right-click entirely.
      if (event.button !== 0) return;

      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      event.currentTarget.setPointerCapture(event.pointerId);

      const state = store.getState();

      // The hand tool drags the view, so it takes precedence over everything -
      // including the ruler, which would otherwise scrub out from under it.
      if (state.ui.tool === 'hand') {
        dragRef.current = {
          kind: 'pan',
          startClientX: event.clientX,
          startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
        };
        return;
      }

      // Clicking the ruler always scrubs, whatever tool is active - unless it
      // lands on a marker flag, which selects the marker and jumps to it.
      if (y < RULER_HEIGHT) {
        if (hitsPlayheadScissors(state.project, state.ui, x, y)) {
          dragRef.current = { kind: 'scissors', startClientX: event.clientX };
          return;
        }

        const marker = markerAtPixel(state.project, state.ui, x);
        if (marker) {
          state.setUi({ selectedMarkerId: marker.id });
          state.setCurrentFrame(marker.frame);
          // Still a scrub if the pointer moves on. Zoomed out, a flag's few
          // pixels cover hundreds of frames, and a press anywhere near one used
          // to grab the marker and ignore the drag: across a fitted hour with
          // markers every minute, the ruler could not be scrubbed at all.
          dragRef.current = { kind: 'scrub' };
          emitScrub(store.getState().project.currentFrame);
          return;
        }

        if (state.ui.selectedMarkerId) state.setUi({ selectedMarkerId: null });
        dragRef.current = { kind: 'scrub' };
        state.setCurrentFrame(pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx));
        emitScrub(store.getState().project.currentFrame);
        return;
      }

      const hit = clipAtPoint(x, y);

      if (state.ui.tool === 'razor') {
        const action = razorClick(
          hit?.clip ?? null,
          pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx),
          state.project.currentFrame,
        );
        if (action.kind === 'cut') state.razorAtFrame(action.frame, [action.clipId]);
        else state.setCurrentFrame(action.frame);
        return;
      }

      const additive = event.shiftKey || event.ctrlKey || event.metaKey;

      if (!hit) {
        // Nothing happens until the pointer moves: a drag draws a rubber band,
        // a plain click (decided on release) still deselects and moves the
        // playhead, as it always did.
        dragRef.current = {
          kind: 'marquee',
          startContentX: x + ui.scrollLeftPx,
          startY: y,
          base: additive ? [...state.ui.selectedClipIds] : [],
          additive,
          moved: false,
        };
        return;
      }

      // Ctrl+click adds or removes one clip, like Ctrl+click in a file list.
      if (event.ctrlKey || event.metaKey) {
        const current = state.ui.selectedClipIds;
        state.selectClips(
          current.includes(hit.clip.id)
            ? current.filter((id) => id !== hit.clip.id)
            : [...current, hit.clip.id],
        );
        return;
      }

      const alreadySelected = state.ui.selectedClipIds.includes(hit.clip.id);
      // Pressing on a clip that is already part of a selection keeps the
      // selection, so the group can be dragged. It used to collapse to the one
      // clip, which made moving several clips together impossible.
      //
      // Alt takes just this clip, linked or not: the way to nudge one half of
      // a linked pair without having to unlink it first.
      if (!alreadySelected || (event.altKey && state.ui.selectedClipIds.length > 1)) {
        state.selectClips([hit.clip.id], event.shiftKey, event.altKey);
      }

      // The fade grips live in the top corners, inside the clip. They are
      // checked before the trim edges, which occupy the same few pixels
      // lower down: the top strip fades, the rest trims.
      const withinRowY = (y - RULER_HEIGHT) % (TRACK_HEIGHT + TRACK_GAP);
      if (state.ui.tool === 'select' && withinRowY <= FADE_GRIP_ZONE_PX) {
        const clipStartX = hit.clip.startFrame * ui.pixelsPerFrame - ui.scrollLeftPx;
        const clipEndX = clipEndFrame(hit.clip) * ui.pixelsPerFrame - ui.scrollLeftPx;
        const fadeInX = clipStartX + (hit.clip.fadeInFrames ?? 0) * ui.pixelsPerFrame;
        const fadeOutX = clipEndX - (hit.clip.fadeOutFrames ?? 0) * ui.pixelsPerFrame;

        if (Math.abs(x - fadeInX) <= FADE_GRIP_PX) {
          dragRef.current = { kind: 'fade', clipId: hit.clip.id, edge: 'in' };
          return;
        }
        if (Math.abs(x - fadeOutX) <= FADE_GRIP_PX) {
          dragRef.current = { kind: 'fade', clipId: hit.clip.id, edge: 'out' };
          return;
        }
      }

      if (state.ui.tool === 'trim') {
        // Which trim depends on where on the clip the pointer is: a shared
        // join rolls, a free edge ripples, the top half slips and the
        // bottom half slides - the way Resolve's trim tool decides.
        const frameAt = (x + ui.scrollLeftPx) / ui.pixelsPerFrame;
        const withinRow = (y - RULER_HEIGHT) % (TRACK_HEIGHT + TRACK_GAP);
        const target = trimTargetAt(
          state.project.clips,
          hit.clip,
          frameAt,
          Math.min(1, Math.max(0, withinRow / TRACK_HEIGHT)),
          TRIM_HANDLE_PX / ui.pixelsPerFrame,
        );
        dragRef.current = {
          kind: 'smartTrim',
          target,
          startFrame: frameAt,
          base: { ...state.project.clips },
        };
        return;
      }

      if (hit.edge) {
        dragRef.current = { kind: 'trim', clipId: hit.clip.id, edge: hit.edge };
        return;
      }

      const pointerFrame = (x + ui.scrollLeftPx) / ui.pixelsPerFrame;
      const selection = store.getState().ui.selectedClipIds;

      if (selection.length > 1) {
        const current = store.getState().project.clips;
        dragRef.current = {
          kind: 'group',
          anchorId: hit.clip.id,
          grabOffsetFrames: pointerFrame - hit.clip.startFrame,
          origins: new Map(
            selection
              .filter((id) => current[id])
              .map((id) => [id, current[id].startFrame] as [string, number]),
          ),
          base: current,
          collapseTo: alreadySelected && !event.shiftKey ? hit.clip.id : null,
          collapseExact: event.altKey,
          moved: false,
        };
        return;
      }

      dragRef.current = {
        kind: 'move',
        clipId: hit.clip.id,
        grabOffsetFrames: pointerFrame - hit.clip.startFrame,
        base: store.getState().project.clips,
      };
    },
    [clipAtPoint, store, ui.pixelsPerFrame, ui.scrollLeftPx],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;

      if (drag.kind === 'none') {
        // Not dragging: track what is under the pointer, so the trim handles
        // and the cursor can say what a press would do. Only on a change -
        // pointermove fires far more often than this can matter.
        const hit = store.getState().ui.tool === 'select' ? clipAtPoint(x, y) : null;
        const next = hit ? { clipId: hit.clip.id, edge: hit.edge } : null;
        setHover((previous) =>
          previous?.clipId === next?.clipId && previous?.edge === next?.edge ? previous : next,
        );
        const current = store.getState();
        setOverScissors(y < RULER_HEIGHT && hitsPlayheadScissors(current.project, current.ui, x, y));
        return;
      }

      const state = store.getState();
      const frame = pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx);

      if (drag.kind === 'pan') {
        // Drag right, content moves right: the view scrolls the other way.
        const container = scrollRef.current;
        if (container) {
          container.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startClientX);
        }
        return;
      }

      if (drag.kind === 'scissors' || drag.kind === 'scrub') {
        if (drag.kind === 'scissors') {
          // Grabbing the playhead by its scissors and moving is a scrub.
          if (Math.abs(event.clientX - drag.startClientX) < DRAG_THRESHOLD_PX) return;
          dragRef.current = { kind: 'scrub' };
        }
        const before = state.project.currentFrame;
        state.setCurrentFrame(frame);
        // Only a real move sounds: pointermove also fires for sub-frame jitter.
        const after = store.getState().project.currentFrame;
        if (after !== before) emitScrub(after);
        return;
      }

      if (drag.kind === 'fade') {
        const clip = state.project.clips[drag.clipId];
        if (!clip) return;
        // The grip says where the fade ends, so its length is the distance
        // from the clip's own end of it.
        const frames =
          drag.edge === 'in' ? frame - clip.startFrame : clipEndFrame(clip) - frame;
        state.setClipFade(drag.clipId, drag.edge, frames);
        return;
      }

      if (drag.kind === 'trim') {
        state.trimClip(drag.clipId, drag.edge, frame);
        return;
      }

      if (drag.kind === 'smartTrim') {
        const { target } = drag;
        const delta = frame - drag.startFrame;
        if (target.mode === 'ripple' && target.edge) {
          state.rippleTrimClip(target.clipId, target.edge, frame);
        } else if (target.mode === 'roll' && target.otherId) {
          state.rollEditAt(target.clipId, target.otherId, frame);
        } else if (target.mode === 'slip') {
          // Dragging right shows later footage, which means the picture
          // moves left under the clip - hence the sign.
          state.slipClipBy(target.clipId, -delta, drag.base);
        } else {
          state.slideClipBy(target.clipId, delta, drag.base);
        }
        return;
      }

      if (drag.kind === 'marquee') {
        const contentX = x + ui.scrollLeftPx;
        if (
          !drag.moved &&
          Math.hypot(contentX - drag.startContentX, y - drag.startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        drag.moved = true;

        // Rows are clamped, so a band dragged into the ruler or below the last
        // track still covers the first or last track instead of nothing.
        const rowAt = (py: number): number =>
          Math.min(tracks.length - 1, Math.max(0, trackIndexAtY(Math.max(RULER_HEIGHT, py))));

        const touched = clipsInMarquee(state.project, tracks, {
          frameA: drag.startContentX / ui.pixelsPerFrame,
          frameB: contentX / ui.pixelsPerFrame,
          rowA: rowAt(drag.startY),
          rowB: rowAt(y),
        });
        state.selectClips([...new Set([...drag.base, ...touched])]);
        setMarquee({ x0: drag.startContentX - ui.scrollLeftPx, y0: drag.startY, x1: x, y1: y });
        return;
      }

      if (drag.kind === 'group') {
        const anchor = state.project.clips[drag.anchorId];
        const anchorOrigin = drag.origins.get(drag.anchorId);
        if (!anchor || anchorOrigin === undefined) return;

        const rawStart = Math.max(
          0,
          (x + ui.scrollLeftPx) / ui.pixelsPerFrame - drag.grabOffsetFrames,
        );
        // The grabbed clip snaps; the rest keep their spacing around it. None
        // of the moving clips is a snap target, or the group would snap to
        // itself.
        const targets = collectSnapTargets(state.project, { excludeClipIds: drag.origins.keys() });
        const snap = snapClipMove(rawStart, anchor.durationFrames, targets, {
          pixelsPerFrame: ui.pixelsPerFrame,
          enabled: state.ui.snappingEnabled,
        });

        const delta = snap.frame - anchorOrigin;
        // A vertical drag takes the whole group to other tracks, the way it
        // takes a single clip.
        const anchorRow = tracks.findIndex((track) => track.id === drag.base[drag.anchorId]?.trackId);
        const row = trackIndexAtY(y);
        const deltaTracks = anchorRow >= 0 && row >= 0 && row < tracks.length ? row - anchorRow : 0;
        if (delta !== 0 || deltaTracks !== 0) drag.moved = true;
        setActiveSnap(snap.snapped ? (snap.target ?? null) : null);
        state.moveClipGroup([...drag.origins.keys()], delta, deltaTracks, {
          base: drag.base,
          anchorId: drag.anchorId,
          mergeKey: `move-group:${drag.anchorId}`,
        });
        return;
      }

      const clip = state.project.clips[drag.clipId];
      if (!clip) return;

      const rawStart = Math.max(
        0,
        (x + ui.scrollLeftPx) / ui.pixelsPerFrame - drag.grabOffsetFrames,
      );

      // A vertical drag moves the clip between tracks.
      const targetTrack = tracks[trackIndexAtY(y)] ?? tracks.find((t) => t.id === clip.trackId);
      if (!targetTrack || targetTrack.locked) return;

      // Snap against where clips were before the drag pushed any aside.
      const targets = collectSnapTargets({ ...state.project, clips: drag.base }, { excludeClipIds: [clip.id] });
      const snap = snapClipMove(rawStart, clip.durationFrames, targets, {
        pixelsPerFrame: ui.pixelsPerFrame,
        enabled: state.ui.snappingEnabled,
      });

      setActiveSnap(snap.snapped ? (snap.target ?? null) : null);
      state.moveClipTo(clip.id, targetTrack.id, snap.frame, drag.base);
    },
    [clipAtPoint, store, tracks, ui.pixelsPerFrame, ui.scrollLeftPx],
  );

  /* Drag and drop -------------------------------------------------------- */

  /** Frame and track under a drag, in content space, snapped like a move. */
  const dropTargetAt = useCallback(
    (event: React.DragEvent<HTMLDivElement>): { frame: number; trackId: string | null; snap: SnapTarget | null } => {
      const bounds = event.currentTarget.getBoundingClientRect();
      // The element scrolls with its content, so this x is already content space.
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const state = store.getState();

      const raw = Math.max(0, Math.round(x / state.ui.pixelsPerFrame));
      const snap = snapFrame(raw, collectSnapTargets(state.project), {
        pixelsPerFrame: state.ui.pixelsPerFrame,
        enabled: state.ui.snappingEnabled,
      });

      return {
        frame: snap.frame,
        trackId: tracks[trackIndexAtY(y)]?.id ?? null,
        snap: { frame: snap.frame, kind: snap.target?.kind ?? 'playhead' },
      };
    },
    [store, tracks],
  );

  const acceptsDrag = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes(ASSET_DRAG_TYPE);

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setActiveSnap(dropTargetAt(event).snap);
    },
    [dropTargetAt],
  );

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // dragleave also fires when moving onto a child; only clear on a real exit.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActiveSnap(null);
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrag(event)) return;
      event.preventDefault();
      setActiveSnap(null);

      const { frame, trackId } = dropTargetAt(event);
      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
      const files = Array.from(event.dataTransfer.files);
      const state = store.getState();

      let assets: MediaAsset[] = [];
      if (assetId) {
        const asset = state.assets.find((candidate) => candidate.id === assetId);
        if (asset && !asset.missing) assets = [asset];
      } else if (files.length > 0) {
        setDropNotice('Importing...');
        const outcome = await importDroppedFiles(files, state.project.fps).catch((error: unknown) => ({
          assets: [],
          rejected: [{ name: 'drop', reason: error instanceof Error ? error.message : String(error) }],
        }));
        store.getState().addAssets(outcome.assets);
        // addAssets may adopt the first import's frame rate and rescale the
        // assets with it, so read them back rather than using the originals.
        const ids = new Set(outcome.assets.map((asset) => asset.id));
        assets = store.getState().assets.filter((asset) => ids.has(asset.id));

        setDropNotice(
          outcome.rejected.length > 0
            ? `Could not import ${outcome.rejected.map((entry) => `${entry.name} (${entry.reason})`).join(', ')}`
            : null,
        );
      }

      if (assets.length === 0) return;

      const current = store.getState();
      current.placeAssets(assets, planDrop(current.project, assets, trackId, frame));
    },
    [dropTargetAt, store],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const drag = dragRef.current;
      const state = store.getState();

      // The scissors on the playhead, clicked: cut at the line. The selected
      // clips if there are any, otherwise everything the playhead crosses.
      if (drag.kind === 'scissors') {
        const selected = state.ui.selectedClipIds;
        state.razorAtFrame(state.project.currentFrame, selected.length > 0 ? selected : undefined);
      }

      // A press on empty space that never became a drag is a click: deselect
      // (unless adding) and put the playhead there, as a click always did.
      if (drag.kind === 'marquee' && !drag.moved) {
        if (!drag.additive) state.selectClips([]);
        const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
        state.setCurrentFrame(pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx));
      }

      // A click (no drag) on one clip of a selection narrows it to that clip.
      if (drag.kind === 'group' && !drag.moved && drag.collapseTo) {
        // Without Alt this keeps a linked group whole, which is the point of
        // linking; with Alt it holds the one clip that was clicked.
        state.selectClips([drag.collapseTo], false, drag.collapseExact);
      }

      dragRef.current = { kind: 'none' };
      setActiveSnap(null);
      setMarquee(null);
    },
    [store, ui.pixelsPerFrame, ui.scrollLeftPx],
  );

  // Read straight off the live drag: every drag that matters changes the
  // project or the marquee on each move, so this re-renders as it goes.
  const drag = dragRef.current;
  const activeTrim = drag.kind === 'trim' ? { clipId: drag.clipId, edge: drag.edge } : null;
  const cursor =
    overScissors && ui.tool !== 'hand' && drag.kind === 'none'
      ? 'pointer'
      : ui.tool === 'hand'
      ? drag.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : ui.tool === 'trim'
        ? drag.kind === 'smartTrim'
          ? drag.target.mode === 'slip'
            ? 'grabbing'
            : drag.target.mode === 'slide'
              ? 'move'
              : 'col-resize'
          : hover?.edge
            ? 'col-resize'
            : 'grab'
      : ui.tool === 'razor'
        ? 'crosshair'
        : drag.kind === 'trim'
          ? 'ew-resize'
          : drag.kind === 'move' || drag.kind === 'group'
            ? 'grabbing'
            : drag.kind === 'marquee'
              ? 'crosshair'
              : hover?.edge
                ? 'ew-resize'
                : hover
                  ? 'grab'
                  : 'default';

  const toolButton = (
    tool: 'select' | 'razor' | 'hand' | 'trim',
    label: string,
    hint: string,
    Icon: typeof MousePointer2,
  ): JSX.Element => (
    <button
      type="button"
      title={hint}
      aria-pressed={ui.tool === tool}
      className={`tool-button ${ui.tool === tool ? 'tool-button-active' : ''}`}
      onClick={() => store.getState().setTool(tool)}
    >
      <Icon size={14} />
      {label}
    </button>
  );

  return (
    <section className="panel h-full">
      <header className="panel-header justify-between">
        {/* Named like the other three panels: it was the only one without a
            title, which made the row read as a floating toolbar. */}
        <span className="hidden shrink-0 pr-1 xl:inline">Timeline</span>
        <div className="flex items-center gap-1.5 font-normal">
          <div className="toolbar-group">
            {toolButton('select', 'Select', 'Selection tool (V)', MousePointer2)}
            {toolButton('razor', 'Razor', 'Razor tool (C) - click a clip to cut it at the playhead', Scissors)}
            {toolButton('hand', 'Pan', 'Hand tool (H)', Hand)}
            {toolButton(
              'trim',
              'Trim',
              'Trim tool (T): a shared join rolls, a free edge ripples, the top of a clip slips and the bottom slides',
              ArrowLeftRight,
            )}
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              title="Split at playhead (B)"
              className="tool-button"
              onClick={() => store.getState().razorAtFrame()}
            >
              <Scissors size={14} />
              Split at playhead
            </button>

            <button
              type="button"
              title="Delete selected clips (Del)"
              className="tool-button hover:text-red-400"
              disabled={ui.selectedClipIds.length === 0}
              onClick={() => store.getState().removeClips(ui.selectedClipIds)}
            >
              <Trash2 size={14} />
              Delete
            </button>

            <button
              type="button"
              title="Snap to clip edges, the playhead and markers (S)"
              aria-pressed={ui.snappingEnabled}
              className={`tool-button ${ui.snappingEnabled ? 'tool-button-active' : ''}`}
              onClick={() => store.getState().setUi({ snappingEnabled: !ui.snappingEnabled })}
            >
              <Crosshair size={14} />
              Snap
            </button>

            <button
              type="button"
              title="Magnet (N): deleting, moving or trimming a clip closes the gap it leaves"
              aria-pressed={ui.rippleEnabled}
              className={`tool-button ${ui.rippleEnabled ? 'tool-button-active' : ''}`}
              onClick={() => store.getState().setUi({ rippleEnabled: !ui.rippleEnabled })}
            >
              <Magnet size={14} />
              Magnet
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              title="Add marker at the playhead (M)"
              className="tool-button"
              onClick={() => {
                const id = store.getState().addMarker();
                if (id) setRenamingMarkerId(id);
              }}
            >
              <Flag size={14} />
              Marker
            </button>
            <button
              type="button"
              title="Previous marker"
              className="tool-button"
              disabled={project.markers.length === 0}
              onClick={() => store.getState().goToMarker(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              title="Next marker"
              className="tool-button"
              disabled={project.markers.length === 0}
              onClick={() => store.getState().goToMarker(1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 font-normal">
          <div className="toolbar-group">
            <button
              type="button"
              title="Add video track"
              className="tool-button"
              onClick={() => store.getState().addTrack('video')}
            >
              <Plus size={14} />
              Video
            </button>
            <button
              type="button"
              title="Add audio track"
              className="tool-button"
              onClick={() => store.getState().addTrack('audio')}
            >
              <Plus size={14} />
              Audio
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              title="Zoom out (-, or Ctrl+wheel)"
              className="tool-button"
              onClick={() => store.getState().zoomBy(1 / 1.4)}
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              title="Zoom in (=, or Ctrl+wheel)"
              className="tool-button"
              onClick={() => store.getState().zoomBy(1.4)}
            >
              <ZoomIn size={14} />
            </button>
            <button
              type="button"
              title="Fit the whole timeline in view (\)"
              className="tool-button"
              onClick={() => store.getState().zoomToFit()}
            >
              <Maximize2 size={14} />
              Fit
            </button>
          </div>
        </div>
      </header>

      {dropNotice && (
        <p className="border-b border-panel-700 bg-amber-950/40 px-3 py-1.5 text-2xs text-amber-300">
          {dropNotice}
        </p>
      )}

      {/* Scrolls vertically as one, headers and tracks together, so a timeline
          dragged shorter than its tracks still reaches every row. */}
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div
          className="shrink-0 overflow-hidden border-r border-panel-700 bg-panel-900"
          style={{ width: HEADER_WIDTH }}
        >
          <div style={{ height: RULER_HEIGHT }} className="border-b border-panel-700" />
          {tracks.map((track, index) => (
            <div
              key={track.id}
              className="group flex flex-col justify-center gap-1 border-b border-panel-800 px-2 hover:bg-panel-800"
              style={{ height: TRACK_HEIGHT, marginTop: index === 0 ? 0 : TRACK_GAP }}
              onContextMenu={(event) => openMenu(event, trackMenuItems(track))}
            >
              <div className="flex items-center justify-between gap-1">
                {renamingTrackId === track.id ? (
                  <input
                    autoFocus
                    defaultValue={track.name}
                    className="numeric-input h-6"
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== track.name) {
                        store.getState().updateTrack(track.id, { name });
                      }
                      setRenamingTrackId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setRenamingTrackId(null);
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      title="Double-click to rename, right-click for more"
                      className="min-w-0 flex-1 truncate text-left text-xs text-slate-300"
                      onDoubleClick={() => setRenamingTrackId(track.id)}
                    >
                      {track.name}
                    </button>
                    <span className="shrink-0 text-2xs uppercase text-slate-400">
                      {track.type}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="tool-button h-6 px-1.5"
                  title={track.visible ? 'Hide track' : 'Show track'}
                  onClick={() =>
                    store.getState().updateTrack(track.id, { visible: !track.visible })
                  }
                >
                  {track.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button
                  type="button"
                  className="tool-button h-6 px-1.5"
                  title={track.muted ? 'Unmute track' : 'Mute track'}
                  onClick={() => store.getState().updateTrack(track.id, { muted: !track.muted })}
                >
                  {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button
                  type="button"
                  className="tool-button h-6 px-1.5"
                  title={track.locked ? 'Unlock track' : 'Lock track'}
                  onClick={() => store.getState().updateTrack(track.id, { locked: !track.locked })}
                >
                  {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>

                <span className="flex-1" />

                <button
                  type="button"
                  className="tool-button h-6 px-1.5 opacity-0 hover:text-red-400 group-hover:opacity-100"
                  title="Delete track"
                  disabled={tracks.length <= 1}
                  onClick={() => store.getState().removeTrack(track.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {/* Positioned in CONTENT space, so the rename field rides the scroll
              with its marker instead of needing scroll arithmetic. */}
          <div
            className="relative"
            style={{ width: contentWidth }}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={(event) => void onDrop(event)}
          >
            {/* The canvas is the size of the VIEW and stays put while the
                content scrolls under it; this div's full width only exists to
                give the scrollbar its range. The canvas used to be as wide as
                the whole timeline - hundreds of thousands of pixels for long
                footage, past what a canvas can be - and it scrolled physically
                while also subtracting the scroll when painting, so everything
                moved at twice the scrollbar's speed. */}
            <div className="sticky left-0" style={{ width: viewportWidth }}>
              <TimelineCanvas
                project={project}
                ui={ui}
                tracks={tracks}
                activeSnap={activeSnap}
                marquee={marquee}
                hover={hover}
                activeTrim={activeTrim}
                cursor={cursor}
                onPointerLeave={() => setHover(null)}
                waveforms={waveforms}
                width={viewportWidth}
                height={Math.max(canvasHeight, trackRowTop(tracks.length))}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onCanvasContextMenu}
              />
            </div>

            {renamingMarker && (
              <input
                autoFocus
                defaultValue={renamingMarker.label}
                className="numeric-input absolute h-6 w-36"
                style={{
                  left: Math.max(0, renamingMarker.frame * ui.pixelsPerFrame + 6),
                  top: 0,
                }}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  const label = event.target.value.trim();
                  if (label && label !== renamingMarker.label) {
                    store.getState().updateMarker(renamingMarker.id, { label });
                  }
                  setRenamingMarkerId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setRenamingMarkerId(null);
                }}
              />
            )}
          </div>
        </div>
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}

      {speedFor && project.clips[speedFor] && (
        <SpeedDialog
          clip={project.clips[speedFor]}
          fps={project.fps}
          onClose={() => setSpeedFor(null)}
          onApply={(change) => {
            store.getState().setClipSpeed(speedFor, change);
            setSpeedFor(null);
          }}
        />
      )}
    </section>
  );
}

export default Timeline;
