import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Hand,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Plus,
  Scissors,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Clip } from '@shared/types';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { clipEndFrame, clipsOnTrack } from './timelineOps';
import { collectSnapTargets, pixelToFrame, snapClipMove, type SnapTarget } from './snapping';
import TimelineCanvas, {
  RULER_HEIGHT,
  TRACK_GAP,
  TRACK_HEIGHT,
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
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end' };

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

  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
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

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      event.currentTarget.setPointerCapture(event.pointerId);

      const state = store.getState();

      // Clicking the ruler always scrubs, whatever tool is active.
      if (y < RULER_HEIGHT) {
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

      const targets = collectSnapTargets(state.project, {
        excludeClipIds: [clip.id],
        markers: state.ui.markers,
      });
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
    event.currentTarget.releasePointerCapture(event.pointerId);
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
            title="Magnetic snapping (S)"
            aria-pressed={ui.snappingEnabled}
            className={`tool-button ${ui.snappingEnabled ? 'tool-button-active' : ''}`}
            onClick={() => store.getState().setUi({ snappingEnabled: !ui.snappingEnabled })}
          >
            <Magnet size={14} />
            Snap
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
              className="flex flex-col justify-center gap-1 border-b border-panel-800 px-2"
              style={{ height: TRACK_HEIGHT, marginTop: index === 0 ? 0 : TRACK_GAP }}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-xs text-slate-300">{track.name}</span>
                <span className="text-2xs uppercase text-slate-600">{track.type}</span>
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
              </div>
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
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
          />
        </div>
      </div>
    </section>
  );
}

export default Timeline;
