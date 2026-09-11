import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Flag,
  Hand,
  Lock,
  LockOpen,
  Magnet,
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
import type { Clip, Marker, Track } from '@shared/types';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { clipEndFrame, clipsOnTrack } from './timelineOps';
import { collectSnapTargets, pixelToFrame, snapClipMove, type SnapTarget } from './snapping';
import TimelineCanvas, {
  RULER_HEIGHT,
  TRACK_GAP,
  TRACK_HEIGHT,
  markerAtPixel,
  trackIndexAtY,
  trackRowTop,
} from './TimelineCanvas';

/** Width of the grab zone at each end of a clip, in pixels. */
const TRIM_HANDLE_PX = 6;
const HEADER_WIDTH = 168;

type DragMode =
  | { kind: 'none' }
  | { kind: 'scrub' }
  | { kind: 'move'; clipId: string; grabOffsetFrames: number }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end' }
  | { kind: 'pan'; startClientX: number; startScrollLeft: number };

/** Multi-track timeline: track headers plus the canvas editing surface. */
export function Timeline(): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const waveforms = useMediaStore((state) => state.waveforms);
  const store = useProjectStore;

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [activeSnap, setActiveSnap] = useState<SnapTarget | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [renamingMarkerId, setRenamingMarkerId] = useState<string | null>(null);

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
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
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

      for (const clip of clipsOnTrack(project, track.id)) {
        if (frame < clip.startFrame || frame > clipEndFrame(clip)) continue;

        const startX = clip.startFrame * ui.pixelsPerFrame - ui.scrollLeftPx;
        const endX = clipEndFrame(clip) * ui.pixelsPerFrame - ui.scrollLeftPx;

        if (Math.abs(x - startX) <= TRIM_HANDLE_PX) return { clip, edge: 'start' };
        if (Math.abs(x - endX) <= TRIM_HANDLE_PX) return { clip, edge: 'end' };
        return { clip, edge: null };
      }
      return null;
    },
    [project, tracks, ui.pixelsPerFrame, ui.scrollLeftPx],
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
          disabled: index === 0,
          onSelect: () => state.moveTrack(track.id, -1),
        },
        {
          label: 'Move down',
          icon: ArrowDown,
          disabled: index === tracks.length - 1,
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
          label: selected.length > 1 ? `Duplicate ${selected.length} clips` : 'Duplicate',
          icon: Copy,
          onSelect: () => state.duplicateClips(selected),
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
        const marker = markerAtPixel(state.project, state.ui, x);
        if (marker) {
          state.setUi({ selectedMarkerId: marker.id });
          state.setCurrentFrame(marker.frame);
          return;
        }

        if (state.ui.selectedMarkerId) state.setUi({ selectedMarkerId: null });
        dragRef.current = { kind: 'scrub' };
        state.setCurrentFrame(pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx));
        return;
      }

      const hit = clipAtPoint(x, y);

      if (state.ui.tool === 'razor') {
        const frame = pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx);
        state.razorAtFrame(frame, hit ? [hit.clip.id] : undefined);
        return;
      }

      if (!hit) {
        state.selectClips([]);
        dragRef.current = { kind: 'scrub' };
        state.setCurrentFrame(pixelToFrame(x, ui.pixelsPerFrame, ui.scrollLeftPx));
        return;
      }

      state.selectClips([hit.clip.id], event.shiftKey);

      if (hit.edge) {
        dragRef.current = { kind: 'trim', clipId: hit.clip.id, edge: hit.edge };
        return;
      }

      const pointerFrame = (x + ui.scrollLeftPx) / ui.pixelsPerFrame;
      dragRef.current = {
        kind: 'move',
        clipId: hit.clip.id,
        grabOffsetFrames: pointerFrame - hit.clip.startFrame,
      };
    },
    [clipAtPoint, store, ui.pixelsPerFrame, ui.scrollLeftPx],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag.kind === 'none') return;

      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
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

      if (drag.kind === 'scrub') {
        state.setCurrentFrame(frame);
        return;
      }

      if (drag.kind === 'trim') {
        state.trimClip(drag.clipId, drag.edge, frame);
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

      const targets = collectSnapTargets(state.project, { excludeClipIds: [clip.id] });
      const snap = snapClipMove(rawStart, clip.durationFrames, targets, {
        pixelsPerFrame: ui.pixelsPerFrame,
        enabled: state.ui.snappingEnabled,
      });

      setActiveSnap(snap.snapped ? (snap.target ?? null) : null);
      state.moveClipTo(clip.id, targetTrack.id, snap.frame);
    },
    [store, tracks, ui.pixelsPerFrame, ui.scrollLeftPx],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = { kind: 'none' };
    setActiveSnap(null);
  }, []);

  const toolButton = (
    tool: 'select' | 'razor' | 'hand',
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
        <div className="flex items-center gap-1 normal-case tracking-normal">
          {toolButton('select', 'Select', 'Selection tool (V)', MousePointer2)}
          {toolButton('razor', 'Razor', 'Razor tool (C) - click a clip to split it', Scissors)}
          {toolButton('hand', 'Pan', 'Hand tool (H)', Hand)}

          <span className="mx-1 h-5 w-px bg-panel-600" />

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
            title="Magnetic snapping (S)"
            aria-pressed={ui.snappingEnabled}
            className={`tool-button ${ui.snappingEnabled ? 'tool-button-active' : ''}`}
            onClick={() => store.getState().setUi({ snappingEnabled: !ui.snappingEnabled })}
          >
            <Magnet size={14} />
            Snap
          </button>

          <span className="mx-1 h-5 w-px bg-panel-600" />

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

        <div className="flex items-center gap-1 normal-case tracking-normal">
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
          <button
            type="button"
            title="Zoom out"
            className="tool-button"
            onClick={() => store.getState().zoomBy(1 / 1.4)}
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            title="Zoom in"
            className="tool-button"
            onClick={() => store.getState().zoomBy(1.4)}
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
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
                    <span className="shrink-0 text-2xs uppercase text-slate-600">
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
          <div className="relative" style={{ width: contentWidth }}>
            <TimelineCanvas
              project={project}
              ui={ui}
              tracks={tracks}
              activeSnap={activeSnap}
              waveforms={waveforms}
              width={contentWidth}
              height={Math.max(canvasHeight, trackRowTop(tracks.length))}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onContextMenu={onCanvasContextMenu}
            />

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
    </section>
  );
}

export default Timeline;
