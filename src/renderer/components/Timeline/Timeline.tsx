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
import { dismissNotification, notify } from '@renderer/notifications/notifications';
import { keyLabel, t, useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { MAX_PIXELS_PER_FRAME, MIN_PIXELS_PER_FRAME } from './zoom';
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
import { useIndicator } from '@renderer/motion/useIndicator';
import TimelineCanvas, {
  type ClipHover,
  RULER_HEIGHT,
  TRACK_TYPE_COLORS,
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
  // Re-renders the toolbar when the language changes; menus read `t` as they open.
  const tr = useT();
  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const waveforms = useMediaStore((state) => state.waveforms);
  const store = useProjectStore;

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [activeSnap, setActiveSnap] = useState<SnapTarget | null>(null);
  /** The clip whose Speed/Duration dialog is open, if any. */
  const [speedFor, setSpeedFor] = useState<string | null>(null);
  /** The chosen tool's highlight, which slides from tool to tool. */
  const toolIndicator = useIndicator<HTMLDivElement, HTMLSpanElement>(ui.tool);

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
          label: t('timeline.renameTrack'),
          icon: Pencil,
          onSelect: () => setRenamingTrackId(track.id),
        },
        { separator: true },
        {
          label: t('timeline.addTrackAbove'),
          icon: Plus,
          onSelect: () => state.addTrackAt(track.type, index),
        },
        {
          label: t('timeline.addTrackBelow'),
          icon: Plus,
          onSelect: () => state.addTrackAt(track.type, index + 1),
        },
        { separator: true },
        {
          label: t('timeline.moveUp'),
          icon: ArrowUp,
          // Within its group: a picture track never goes below the audio.
          disabled: !canMoveTrack(tracks, track.id, -1),
          onSelect: () => state.moveTrack(track.id, -1),
        },
        {
          label: t('timeline.moveDown'),
          icon: ArrowDown,
          disabled: !canMoveTrack(tracks, track.id, 1),
          onSelect: () => state.moveTrack(track.id, 1),
        },
        { separator: true },
        {
          label: t(track.visible ? 'timeline.hideTrack' : 'timeline.showTrack'),
          icon: track.visible ? EyeOff : Eye,
          onSelect: () => state.updateTrack(track.id, { visible: !track.visible }),
        },
        {
          label: t(track.muted ? 'timeline.unmuteTrack' : 'timeline.muteTrack'),
          icon: track.muted ? Volume2 : VolumeX,
          onSelect: () => state.updateTrack(track.id, { muted: !track.muted }),
        },
        {
          label: t(track.locked ? 'timeline.unlockTrack' : 'timeline.lockTrack'),
          icon: track.locked ? LockOpen : Lock,
          onSelect: () => state.updateTrack(track.id, { locked: !track.locked }),
        },
        { separator: true },
        {
          // Saying how much goes with it makes an undoable delete predictable.
          label: clipCount > 0 ? t('timeline.deleteTrackClips', { count: clipCount }) : t('timeline.deleteTrack'),
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
          label: t('timeline.split'),
          icon: Scissors,
          shortcut: 'B',
          disabled: !canSplit,
          onSelect: () => state.razorAtFrame(state.project.currentFrame, [clip.id]),
        },
        {
          label: t('timeline.speed'),
          icon: Gauge,
          shortcut: 'Ctrl+R',
          onSelect: () => setSpeedFor(clip.id),
        },
        {
          label: selected.length > 1 ? t('timeline.duplicateMany', { count: selected.length }) : t('timeline.duplicate'),
          icon: Copy,
          onSelect: () => state.duplicateClips(selected),
        },
        { separator: true },
        {
          label: isLinked(state.project.clips, selected)
            ? t('timeline.unlink')
            : selected.length > 1
              ? t('timeline.link', { count: selected.length })
              : t('timeline.linkClips'),
          icon: Link2,
          shortcut: keyLabel(isLinked(state.project.clips, selected) ? 'Ctrl+Shift+L' : 'Ctrl+L'),
          disabled: selected.length < 2 && !clip.linkGroup,
          onSelect: () => {
            state.selectClips(selected);
            if (clip.linkGroup) state.unlinkSelection();
            else state.linkSelection();
          },
        },
        { separator: true },
        {
          label: t('timeline.cut'),
          icon: Scissors,
          shortcut: 'Ctrl+X',
          onSelect: () => {
            state.selectClips(selected);
            state.cutSelection();
          },
        },
        {
          label: t('timeline.copy'),
          icon: Copy,
          shortcut: 'Ctrl+C',
          onSelect: () => {
            state.selectClips(selected);
            state.copySelection();
          },
        },
        {
          label: t('timeline.paste'),
          icon: ClipboardPaste,
          shortcut: 'Ctrl+V',
          disabled: !state.clipboard,
          onSelect: () => state.paste(),
        },
        { separator: true },
        {
          label: t(clip.mask.enabled ? 'timeline.maskOff' : 'timeline.maskOn'),
          onSelect: () =>
            state.updateClip(clip.id, { mask: { ...clip.mask, enabled: !clip.mask.enabled } }),
        },
        {
          label: t(clip.chromaKey.enabled ? 'timeline.chromaOff' : 'timeline.chromaOn'),
          onSelect: () =>
            state.updateClip(clip.id, {
              chromaKey: { ...clip.chromaKey, enabled: !clip.chromaKey.enabled },
            }),
        },
        {
          label: t(clip.pixelArt.enabled ? 'timeline.pixelOff' : 'timeline.pixelOn'),
          onSelect: () =>
            state.updateClip(clip.id, {
              pixelArt: { ...clip.pixelArt, enabled: !clip.pixelArt.enabled },
            }),
        },
        { separator: true },
        {
          label: selected.length > 1 ? t('timeline.deleteClips', { count: selected.length }) : t('timeline.deleteClip'),
          icon: Trash2,
          shortcut: keyLabel('Del'),
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
      { label: t('timeline.addVideoTrack'), icon: Plus, onSelect: () => state.addTrack('video') },
      { label: t('timeline.addAudioTrack'), icon: Plus, onSelect: () => state.addTrack('audio') },
      { separator: true },
      {
        label: t('timeline.split'),
        icon: Scissors,
        shortcut: 'B',
        onSelect: () => state.razorAtFrame(),
      },
      {
        label: t('timeline.paste'),
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
            label: t('timeline.renameMarker'),
            icon: Pencil,
            onSelect: () => {
              state.setUi({ selectedMarkerId: marker.id });
              setRenamingMarkerId(marker.id);
            },
          },
          {
            label: t('timeline.markerToPlayhead'),
            icon: Flag,
            disabled: marker.frame === state.project.currentFrame,
            onSelect: () => state.updateMarker(marker.id, { frame: state.project.currentFrame }),
          },
          { separator: true },
          {
            label: t('timeline.deleteMarker'),
            icon: Trash2,
            danger: true,
            onSelect: () => state.removeMarker(marker.id),
          },
        ];
      }

      return [
        {
          label: t('timeline.addMarkerHere'),
          icon: Flag,
          onSelect: () => {
            const id = state.addMarker(frame);
            if (id) setRenamingMarkerId(id);
          },
        },
        {
          label: t('timeline.addMarkerAtPlayhead'),
          icon: Flag,
          shortcut: 'M',
          onSelect: () => {
            const id = state.addMarker();
            if (id) setRenamingMarkerId(id);
          },
        },
        { separator: true },
        {
          label: markerCount > 0 ? t('timeline.clearMarkersCount', { count: markerCount }) : t('timeline.clearMarkers'),
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
        const importing = notify(t('notify.importing'), 'info', { persistent: true });
        const outcome = await importDroppedFiles(files, state.project.fps).catch((error: unknown) => ({
          assets: [],
          rejected: [{ name: 'drop', reason: error instanceof Error ? error.message : String(error) }],
        }));
        store.getState().addAssets(outcome.assets);
        // addAssets may adopt the first import's frame rate and rescale the
        // assets with it, so read them back rather than using the originals.
        const ids = new Set(outcome.assets.map((asset) => asset.id));
        assets = store.getState().assets.filter((asset) => ids.has(asset.id));

        dismissNotification(importing);
        if (outcome.rejected.length > 0) {
          notify(
            t('notify.importFailed', { detail: outcome.rejected.map((entry) => `${entry.name} (${entry.reason})`).join(', ') }),
            'error',
          );
        }
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

  /** One segment of the tool picker: an icon, its name for the tooltip and the screen reader, its key. */
  const toolButton = (
    tool: 'select' | 'razor' | 'hand' | 'trim',
    label: string,
    key: string,
    hint: string,
    Icon: typeof MousePointer2,
  ): JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={ui.tool === tool}
      className={`tool-button tool-button-dense relative w-7 px-0 ${ui.tool === tool ? 'text-slate-50 hover:bg-transparent' : ''}`}
      onClick={() => store.getState().setTool(tool)}
      {...tip(label, { shortcut: key, hint })}
    >
      <Icon size={14} />
    </button>
  );

  /** An icon button that says what it does in its tooltip. */
  const iconButton = (
    label: string,
    Icon: typeof MousePointer2,
    onClick: () => void,
    options: { shortcut?: string; hint?: string; pressed?: boolean; disabled?: boolean; danger?: boolean } = {},
  ): JSX.Element => (
    <button
      type="button"
      aria-pressed={options.pressed}
      disabled={options.disabled}
      className={`tool-button tool-button-dense w-7 px-0 ${options.pressed ? 'tool-button-active' : ''} ${options.danger ? 'hover:text-red-400' : ''}`}
      onClick={onClick}
      {...tip(label, { shortcut: options.shortcut, hint: options.hint })}
    >
      <Icon size={14} />
    </button>
  );

  // The zoom slider works in logarithmic steps: each notch is the same
  // factor, the way a zoom feels, rather than the same number of pixels.
  const logMin = Math.log(MIN_PIXELS_PER_FRAME);
  const logMax = Math.log(MAX_PIXELS_PER_FRAME);
  const zoomValue = (Math.log(ui.pixelsPerFrame) - logMin) / (logMax - logMin);

  return (
    <section className="panel h-full">
      {/*
        The toolbar starts where the tracks start: the title sits over the
        track headers (the same 168px) and the tools over the canvas, as in
        Resolve. Icons with tooltips that say the key; the tools are one
        segmented control, since exactly one is always chosen.
      */}
      <header className="panel-header gap-0 !px-0">
        <span className="flex shrink-0 items-center px-3" style={{ width: HEADER_WIDTH }}>
          {tr('timeline.title')}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2 font-normal">
          <div ref={toolIndicator.containerRef} role="radiogroup" aria-label={tr('timeline.tools')} className="toolbar-group relative">
            <span ref={toolIndicator.indicatorRef} aria-hidden className="scf-indicator rounded-control bg-panel-600" />
            {toolButton('select', tr('timeline.toolSelect'), 'V', tr('timeline.toolSelectHint'), MousePointer2)}
            {toolButton('razor', tr('timeline.toolRazor'), 'C', tr('timeline.toolRazorHint'), Scissors)}
            {toolButton('hand', tr('timeline.toolPan'), 'H', tr('timeline.toolPanHint'), Hand)}
            {toolButton('trim', tr('timeline.toolTrim'), 'T', tr('timeline.toolTrimHint'), ArrowLeftRight)}
          </div>

          <div className="flex items-center gap-0.5">
            {iconButton(tr('timeline.split'), Scissors, () => store.getState().razorAtFrame(), { shortcut: 'B' })}
            {iconButton(tr('timeline.deleteSelected'), Trash2, () => store.getState().removeClips(ui.selectedClipIds), {
              shortcut: keyLabel('Del'),
              disabled: ui.selectedClipIds.length === 0,
              danger: true,
            })}
          </div>

          <span aria-hidden className="h-4 w-px shrink-0 bg-panel-700" />

          <div className="flex items-center gap-0.5">
            {iconButton(tr('timeline.snap'), Crosshair, () => store.getState().setUi({ snappingEnabled: !ui.snappingEnabled }), {
              shortcut: 'S',
              hint: tr('timeline.snapHint'),
              pressed: ui.snappingEnabled,
            })}
            {iconButton(tr('timeline.magnet'), Magnet, () => store.getState().setUi({ rippleEnabled: !ui.rippleEnabled }), {
              shortcut: 'N',
              hint: tr('timeline.magnetHint'),
              pressed: ui.rippleEnabled,
            })}
          </div>

          <span aria-hidden className="h-4 w-px shrink-0 bg-panel-700" />

          <div className="flex items-center gap-0.5">
            {iconButton(
              tr('timeline.addMarker'),
              Flag,
              () => {
                const id = store.getState().addMarker();
                if (id) setRenamingMarkerId(id);
              },
              { shortcut: 'M', hint: tr('timeline.addMarkerHint') },
            )}
            {iconButton(tr('timeline.previousMarker'), ChevronLeft, () => store.getState().goToMarker(-1), { disabled: project.markers.length === 0 })}
            {iconButton(tr('timeline.nextMarker'), ChevronRight, () => store.getState().goToMarker(1), { disabled: project.markers.length === 0 })}
          </div>

          <div className="min-w-2 flex-1" />

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="tool-button tool-button-dense px-1.5"
              onClick={() => store.getState().addTrack('video')}
              {...tip(tr('timeline.addVideoTrack'))}
            >
              <Plus size={13} />
              {tr('timeline.video')}
            </button>
            <button
              type="button"
              className="tool-button tool-button-dense px-1.5"
              onClick={() => store.getState().addTrack('audio')}
              {...tip(tr('timeline.addAudioTrack'))}
            >
              <Plus size={13} />
              {tr('timeline.audio')}
            </button>
          </div>

          <span aria-hidden className="h-4 w-px shrink-0 bg-panel-700" />

          <div className="flex shrink-0 items-center gap-1.5">
            {iconButton(tr('timeline.zoomOut'), ZoomOut, () => store.getState().zoomBy(1 / 1.4), { shortcut: '-' })}
            <input
              type="range"
              aria-label={tr('timeline.zoom')}
              className="w-24"
              min={0}
              max={1}
              step={0.005}
              value={zoomValue}
              style={{ '--fill': `${zoomValue * 100}%` } as React.CSSProperties}
              onChange={(event) => {
                const wanted = Math.exp(logMin + Number(event.target.value) * (logMax - logMin));
                store.getState().zoomBy(wanted / ui.pixelsPerFrame);
              }}
              {...tip(tr('timeline.zoom'), { hint: tr('timeline.zoomHint'), named: false })}
            />
            {iconButton(tr('timeline.zoomIn'), ZoomIn, () => store.getState().zoomBy(1.4), { shortcut: '=' })}
            <button
              type="button"
              className="tool-button tool-button-dense px-1.5"
              onClick={() => store.getState().zoomToFit()}
              {...tip(tr('timeline.fitHint'), { shortcut: '\\', named: false })}
            >
              <Maximize2 size={13} />
              {tr('timeline.fit')}
            </button>
          </div>
        </div>
      </header>

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
              className="group relative flex flex-col justify-center gap-1 border-b border-panel-800 pl-3 pr-2 hover:bg-panel-800"
              style={{ height: TRACK_HEIGHT, marginTop: index === 0 ? 0 : TRACK_GAP }}
              onContextMenu={(event) => openMenu(event, trackMenuItems(track))}
            >
              {/* The kind of track as a colour, the one its clips are drawn in,
                  instead of the word VIDEO or AUDIO on every row. */}
              <span
                aria-hidden
                className="absolute inset-y-1 left-0 w-1 rounded-r-sm"
                style={{ background: TRACK_TYPE_COLORS[track.type] }}
              />
              <span className="sr-only">{t(track.type === 'audio' ? 'timeline.audioTrack' : 'timeline.videoTrack')}</span>
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
                      title={t('timeline.renameHint')}
                      className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-200"
                      onDoubleClick={() => setRenamingTrackId(track.id)}
                    >
                      {track.name}
                    </button>
                    <button
                      type="button"
                      className="tool-button tool-button-dense shrink-0 opacity-0 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                      title={t('timeline.deleteTrack')}
                      aria-label={t('timeline.deleteTrack')}
                      disabled={tracks.length <= 1}
                      onClick={() => store.getState().removeTrack(track.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>

              {/* A picture track can be hidden; a sound track has nothing to
                  hide, so it gets solo instead, as in every NLE's audio
                  headers. Both can be muted (a video clip carries its sound)
                  and locked. The state reads from the button itself: pressed,
                  and in colour when it changes what is heard or seen. */}
              <div className="flex items-center gap-0.5">
                {track.type !== 'audio' && (
                  <button
                    type="button"
                    className={`tool-button tool-button-dense ${track.visible ? '' : 'text-amber-300'}`}
                    title={track.visible ? t('timeline.hideTrack') : t('timeline.showTrack')}
                    aria-label={track.visible ? t('timeline.hideTrack') : t('timeline.showTrack')}
                    aria-pressed={!track.visible}
                    onClick={() =>
                      store.getState().updateTrack(track.id, { visible: !track.visible })
                    }
                  >
                    {track.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                )}
                <button
                  type="button"
                  className={`tool-button tool-button-dense ${track.muted ? 'bg-amber-400/15 text-amber-300' : ''}`}
                  title={track.muted ? t('timeline.unmuteTrack') : t('timeline.muteTrack')}
                  aria-label={track.muted ? t('timeline.unmuteTrack') : t('timeline.muteTrack')}
                  aria-pressed={track.muted}
                  onClick={() => store.getState().updateTrack(track.id, { muted: !track.muted })}
                >
                  {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                {track.type === 'audio' && (
                  <button
                    type="button"
                    className={`tool-button tool-button-dense w-6 px-0 text-2xs font-semibold ${track.solo ? 'bg-yellow-300/20 text-yellow-200' : ''}`}
                    title={t('timeline.soloTrack')}
                    aria-label={t('timeline.soloTrack')}
                    aria-pressed={track.solo}
                    onClick={() => store.getState().updateTrack(track.id, { solo: !track.solo })}
                  >
                    S
                  </button>
                )}
                <button
                  type="button"
                  className={`tool-button tool-button-dense ${track.locked ? 'text-amber-300' : ''}`}
                  title={track.locked ? t('timeline.unlockTrack') : t('timeline.lockTrack')}
                  aria-label={track.locked ? t('timeline.unlockTrack') : t('timeline.lockTrack')}
                  aria-pressed={track.locked}
                  onClick={() => store.getState().updateTrack(track.id, { locked: !track.locked })}
                >
                  {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
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
