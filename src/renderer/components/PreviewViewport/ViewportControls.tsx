import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { Clip, ResolvedTransform } from '@shared/types';
import {
  CORNER_HANDLES,
  EDGE_HANDLES,
  angleAround,
  anchorPosition,
  containsPoint,
  handlePositions,
  movedPosition,
  quadCorners,
  rotationFromPointer,
  scaleFromHandle,
  snappedPosition,
  type Handle,
  type Point,
} from './viewportTransform';

/**
 * Moving, scaling and turning a clip by dragging it in the viewer.
 *
 * Every editor worth the name lets you place a picture by pushing it around
 * rather than by typing numbers at it, and these are the same numbers the
 * inspector shows: a drag writes Position, Scale and Rotation at the playhead,
 * so it lands on the keyframe track and animates like anything else.
 *
 * Drawn as an SVG in project coordinates, so the outline and the grips sit
 * exactly where the compositor puts the picture, at any viewer size.
 */

/**
 * How big the grips are on screen, whatever the viewer is scaled to.
 *
 * Small and light: Final Cut draws these as little dots on a hairline, and
 * the picture underneath is the thing being judged. They were 9px squares
 * on a 1.5px fence, which read as a cage around the shot.
 */
const HANDLE_CSS_PX = 7;
const ROTATE_ARM_CSS_PX = 26;
/** Shift-rotate lands on multiples of this. */
const ROTATION_SNAP_DEGREES = 15;
/**
 * The overlay reaches this far outside the frame.
 *
 * A clip at scale 1 fills the frame exactly, so its grips sit on the very edge
 * - and half of each one would be clipped away, leaving the commonest case the
 * hardest to grab. The preview has 16px of padding around it, so this stays
 * inside the panel.
 */
const OVERFLOW_CSS_PX = 14;
/**
 * How close a moved picture has to come before the magnet takes it, in pixels
 * on screen.
 *
 * On screen, not in the project: a fraction of the frame width means the
 * magnet is 38px wide in a 4K project and 3px wide in a 320px one, so the
 * same gesture sticks in one and slips in the other. Ten pixels of pointer
 * travel is what it feels like either way.
 */
const SNAP_CSS_PX = 10;

/** The cursor that says what a grip will do. */
const cursorFor = (handle: Handle): string => {
  if (handle === 'left' || handle === 'right') return 'ew-resize';
  if (handle === 'top' || handle === 'bottom') return 'ns-resize';
  return handle === 'bottomLeft' || handle === 'topRight' ? 'nesw-resize' : 'nwse-resize';
};

type Drag =
  | { kind: 'move'; startPointer: Point; startTransform: ResolvedTransform }
  | { kind: 'scale'; handle: Handle; startTransform: ResolvedTransform }
  | { kind: 'rotate'; grabAngle: number; startTransform: ResolvedTransform };

export function ViewportControls(): JSX.Element | null {
  const project = useProjectStore((state) => state.project);
  const selectedClipIds = useProjectStore((state) => state.ui.selectedClipIds);
  const transformMode = useProjectStore((state) => state.ui.transformMode);
  const snapping = useProjectStore((state) => state.ui.snappingEnabled);
  const setUi = useProjectStore((state) => state.setUi);
  const setTransformAt = useProjectStore((state) => state.setTransformAt);

  const surfaceRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Which guide lines to draw while a drag is held against them. */
  const [guides, setGuides] = useState({ vertical: false, horizontal: false });
  const [projectPxPerCssPx, setProjectPxPerCssPx] = useState(1);

  const frame = useMemo(() => ({ width: project.width, height: project.height }), [project.width, project.height]);
  const currentFrame = project.currentFrame;

  /** Clips with a picture on screen right now, bottom of the stack first. */
  const visibleClips = useMemo(() => {
    const tracks = new Map(Object.values(project.tracks).map((track) => [track.id, track]));
    return Object.values(project.clips)
      .filter((clip) => {
        const track = tracks.get(clip.trackId);
        if (!track || !track.visible || track.type === 'audio') return false;
        return currentFrame >= clip.startFrame && currentFrame < clip.startFrame + clip.durationFrames;
      })
      .sort((a, b) => (tracks.get(a.trackId)?.order ?? 0) - (tracks.get(b.trackId)?.order ?? 0));
  }, [project.clips, project.tracks, currentFrame]);

  /**
   * The clip being transformed: one selected clip, with the mode on.
   *
   * Both conditions matter. Final Cut asks for the mode (Shift+T) and
   * Premiere asks for the selection; wanting neither means wanting to
   * watch the picture, which is what a viewer is for.
   */
  const selected: Clip | null = useMemo(() => {
    if (!transformMode || selectedClipIds.length !== 1) return null;
    return visibleClips.find((clip) => clip.id === selectedClipIds[0]) ?? null;
  }, [transformMode, selectedClipIds, visibleClips]);

  const resolved = useMemo(
    () => (selected ? evaluateTransform(selected.transform, currentFrame) : null),
    [selected, currentFrame],
  );

  // Grips are drawn in project units, so they have to be sized against the
  // picture's size on screen - which is the parent box, not this one: this one
  // deliberately reaches beyond it.
  useEffect(() => {
    const picture = surfaceRef.current?.parentElement;
    if (!picture) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setProjectPxPerCssPx(project.width / width);
    });
    observer.observe(picture);
    return () => observer.disconnect();
  }, [project.width]);

  const overflow = OVERFLOW_CSS_PX * projectPxPerCssPx;

  const pointerToProject = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      return {
        x: ((event.clientX - rect.left) / rect.width) * (project.width + overflow * 2) - overflow,
        y: ((event.clientY - rect.top) / rect.height) * (project.height + overflow * 2) - overflow,
      };
    },
    [project.width, project.height, overflow],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || !selected) return;
      const pointer = pointerToProject(event);

      if (drag.kind === 'move') {
        const delta = { x: pointer.x - drag.startPointer.x, y: pointer.y - drag.startPointer.y };
        const wanted = movedPosition(drag.startTransform, delta);
        // The magnet, unless it is switched off or Alt asks for the exact
        // pixel under the pointer - the escape hatch every snap needs.
        const snap = snapping && !event.altKey
          ? snappedPosition(wanted, drag.startTransform, frame, SNAP_CSS_PX * projectPxPerCssPx)
          : { position: wanted, vertical: false, horizontal: false };
        setGuides({ vertical: snap.vertical, horizontal: snap.horizontal });
        setTransformAt(selected.id, currentFrame, { position: snap.position });
        return;
      }
      if (drag.kind === 'scale') {
        // Scale and position together: the corner opposite the grip has to
        // stay where it is, and that is a move as well as a resize.
        setTransformAt(
          selected.id,
          currentFrame,
          scaleFromHandle(drag.startTransform, drag.handle, pointer, frame, { free: event.shiftKey }),
        );
        return;
      }
      setTransformAt(selected.id, currentFrame, {
        rotation: rotationFromPointer(drag.startTransform, pointer, frame, {
          grabAngle: drag.grabAngle,
          snapDegrees: event.shiftKey ? ROTATION_SNAP_DEGREES : undefined,
        }),
      });
    },
    [selected, pointerToProject, setTransformAt, currentFrame, frame, snapping, projectPxPerCssPx],
  );

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setDragging(false);
    // The guides say "this is why it stopped here" during a drag; afterwards
    // they would just be lines across the picture.
    setGuides({ vertical: false, horizontal: false });
    const surface = surfaceRef.current;
    if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  }, []);

  /**
   * The whole surface captures the pointer, not the grip that was grabbed: a
   * drag that leaves the picture - which is most of them, since scaling up
   * means pulling outwards - has to keep arriving.
   */
  const startDrag = useCallback(
    (event: { preventDefault(): void; stopPropagation(): void; pointerId: number }, drag: Drag) => {
      event.preventDefault();
      event.stopPropagation();
      surfaceRef.current?.setPointerCapture(event.pointerId);
      dragRef.current = drag;
      setDragging(true);
    },
    [],
  );

  /** A press on the picture picks the clip under it, topmost first, and moves it. */
  const onSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const pointer = pointerToProject(event);

      if (selected && resolved && containsPoint(resolved, pointer, frame)) {
        startDrag(event, { kind: 'move', startPointer: pointer, startTransform: resolved });
        return;
      }

      for (let i = visibleClips.length - 1; i >= 0; i -= 1) {
        const clip = visibleClips[i];
        const transform = evaluateTransform(clip.transform, currentFrame);
        if (!containsPoint(transform, pointer, frame)) continue;
        setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
        startDrag(event, { kind: 'move', startPointer: pointer, startTransform: transform });
        return;
      }
      setUi({ selectedClipIds: [] });
    },
    [pointerToProject, selected, resolved, frame, visibleClips, currentFrame, setUi, startDrag],
  );

  if (project.width === 0 || project.height === 0) return null;

  const handleSize = HANDLE_CSS_PX * projectPxPerCssPx;
  const stroke = 1 * projectPxPerCssPx;
  const corners = resolved ? quadCorners(resolved, frame) : [];
  const grips = resolved ? handlePositions(resolved, frame) : null;
  const pivot = resolved ? anchorPosition(resolved, frame) : null;
  const rotateGrip =
    grips && pivot
      ? (() => {
          const away = { x: grips.top.x - pivot.x, y: grips.top.y - pivot.y };
          const size = Math.hypot(away.x, away.y) || 1;
          const reach = ROTATE_ARM_CSS_PX * projectPxPerCssPx;
          return { x: grips.top.x + (away.x / size) * reach, y: grips.top.y + (away.y / size) * reach };
        })()
      : null;

  return (
    <svg
      ref={surfaceRef}
      className="absolute"
      style={{
        left: -OVERFLOW_CSS_PX,
        top: -OVERFLOW_CSS_PX,
        width: `calc(100% + ${OVERFLOW_CSS_PX * 2}px)`,
        height: `calc(100% + ${OVERFLOW_CSS_PX * 2}px)`,
        cursor: dragging ? 'grabbing' : 'default',
        touchAction: 'none',
      }}
      viewBox={`${-overflow} ${-overflow} ${project.width + overflow * 2} ${project.height + overflow * 2}`}
      preserveAspectRatio="none"
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Guides, drawn only while a drag is held against them. */}
      {dragging && guides.vertical && (
        <line
          data-testid="viewport-guide-vertical"
          x1={project.width / 2}
          y1={-overflow}
          x2={project.width / 2}
          y2={project.height + overflow}
          stroke="#f472b6"
          strokeWidth={stroke}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
      {dragging && guides.horizontal && (
        <line
          data-testid="viewport-guide-horizontal"
          x1={-overflow}
          y1={project.height / 2}
          x2={project.width + overflow}
          y2={project.height / 2}
          stroke="#f472b6"
          strokeWidth={stroke}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}

      {resolved && grips && corners.length === 4 && (
        <g>
          {/* Two strokes, one dark under one light: a single colour is
              invisible on a picture of the same colour, and a thicker line
              is a fence. */}
          <polygon
            points={corners.map((corner) => `${corner.x},${corner.y}`).join(' ')}
            fill="transparent"
            stroke="rgba(0, 0, 0, 0.45)"
            strokeWidth={stroke * 2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          <polygon
            points={corners.map((corner) => `${corner.x},${corner.y}`).join(' ')}
            fill="transparent"
            stroke="rgba(255, 255, 255, 0.9)"
            strokeWidth={stroke}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: 'move' }}
          />

          {rotateGrip && (
            <>
              <line
                x1={grips.top.x}
                y1={grips.top.y}
                x2={rotateGrip.x}
                y2={rotateGrip.y}
                stroke="#60a5fa"
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                data-testid="viewport-handle-rotate"
                cx={rotateGrip.x}
                cy={rotateGrip.y}
                r={handleSize * 0.6}
                fill="#0d0f14"
                stroke="#60a5fa"
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'grab' }}
                onPointerDown={(event) =>
                  startDrag(event, {
                    kind: 'rotate',
                    grabAngle: angleAround(resolved, pointerToProject(event), frame),
                    startTransform: resolved,
                  })
                }
              />
            </>
          )}

          {[...CORNER_HANDLES, ...EDGE_HANDLES].map((handle) => {
            const grip = grips[handle];
            const isCorner = CORNER_HANDLES.includes(handle);
            return (
              <rect
                key={handle}
                data-testid={`viewport-handle-${handle}`}
                x={grip.x - handleSize / 2}
                y={grip.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                rx={isCorner ? handleSize * 0.2 : handleSize * 0.45}
                fill="#0d0f14"
                stroke="#60a5fa"
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: cursorFor(handle) }}
                onPointerDown={(event) => startDrag(event, { kind: 'scale', handle, startTransform: resolved })}
              />
            );
          })}

          {/* The anchor: what the clip turns and scales about. */}
          {pivot && (
            <g pointerEvents="none">
              <circle
                cx={pivot.x}
                cy={pivot.y}
                r={handleSize * 0.45}
                fill="none"
                stroke="#60a5fa"
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={pivot.x} cy={pivot.y} r={handleSize * 0.12} fill="#60a5fa" />
            </g>
          )}
        </g>
      )}
    </svg>
  );
}

export default ViewportControls;
