import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { Clip, ResolvedTransform } from '@shared/types';
import { titleGeometry, titleLayout, titleTransformAt } from '@renderer/text/geometry';
import type { TitleAnimationState } from '@renderer/text/animation';
import { TITLE_SAFE } from '@renderer/text/titleStyle';
import {
  CORNER_HANDLES,
  EDGE_HANDLES,
  angleAround,
  anchorPosition,
  containsPoint,
  handlePositions,
  layerToPixels,
  movedPosition,
  quadCorners,
  rotationFromPointer,
  scaleFromHandle,
  snappedPosition,
  snappedTitlePosition,
  type Handle,
  type LayerShape,
  type Point,
} from './viewportTransform';
import { TitleTextEditor } from './TitleTextEditor';

/**
 * Moving, scaling and turning a clip by dragging it in the viewer.
 *
 * Every editor worth the name lets you place a picture by pushing it around
 * rather than by typing numbers at it, and these are the same numbers the
 * inspector shows: a drag writes Position, Scale and Rotation at the playhead,
 * so it lands on the keyframe track and animates like anything else.
 *
 * Titles are handled as Final Cut handles them: a click on the text picks
 * the title and a drag moves it - with or without the transform mode - and
 * a double-click types into it where it is (TitleTextEditor). Their box is
 * their text, not the frame, and they turn about the text's centre. While
 * one is dragged the title-safe area is drawn, and the text sticks to it.
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

/** A clip as the viewer draws and grabs it. */
interface Placed {
  clip: Clip;
  /** What is on screen: for a title, its keyframes with its animation on top. */
  transform: ResolvedTransform;
  /** A title's text box and pivot; absent for a clip that fills the frame. */
  layer?: LayerShape;
  /** A title's animation at this frame, taken back out of what a drag writes. */
  animation?: TitleAnimationState;
}

type Drag =
  | { kind: 'move'; startPointer: Point; startTransform: ResolvedTransform; basePosition: { x: number; y: number }; placed: Placed }
  | { kind: 'scale'; handle: Handle; startTransform: ResolvedTransform; placed: Placed }
  | { kind: 'rotate'; grabAngle: number; startTransform: ResolvedTransform; placed: Placed };

export function ViewportControls(): JSX.Element | null {
  const project = useProjectStore((state) => state.project);
  const selectedClipIds = useProjectStore((state) => state.ui.selectedClipIds);
  const transformMode = useProjectStore((state) => state.ui.transformMode);
  const snapping = useProjectStore((state) => state.ui.snappingEnabled);
  const editingTitleId = useProjectStore((state) => state.ui.editingTitleId);
  const playing = useProjectStore((state) => state.ui.isPlaying);
  const setUi = useProjectStore((state) => state.setUi);
  const setTransformAt = useProjectStore((state) => state.setTransformAt);

  const surfaceRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag['kind'] | null>(null);
  /** Which guide lines to draw while a drag is held against them. */
  const [guides, setGuides] = useState({ vertical: false, horizontal: false, safe: false });
  const [projectPxPerCssPx, setProjectPxPerCssPx] = useState(1);
  /** Bumped when fonts finish loading: a title measured before that is measured again. */
  const [fontsLoaded, setFontsLoaded] = useState(0);

  const frame = useMemo(() => ({ width: project.width, height: project.height }), [project.width, project.height]);
  const currentFrame = project.currentFrame;

  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return undefined;
    const bump = (): void => setFontsLoaded((count) => count + 1);
    fonts.addEventListener('loadingdone', bump);
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);

  /** Clips with a picture on screen right now, bottom of the stack first. */
  const visible = useMemo((): Placed[] => {
    const tracks = new Map(Object.values(project.tracks).map((track) => [track.id, track]));
    return Object.values(project.clips)
      .filter((clip) => {
        const track = tracks.get(clip.trackId);
        if (!track || !track.visible || track.type === 'audio') return false;
        return currentFrame >= clip.startFrame && currentFrame < clip.startFrame + clip.durationFrames;
      })
      .sort((a, b) => (tracks.get(a.trackId)?.order ?? 0) - (tracks.get(b.trackId)?.order ?? 0))
      .map((clip) => {
        if (!clip.title) return { clip, transform: evaluateTransform(clip.transform, currentFrame) };
        const geometry = titleGeometry(clip.title, frame);
        const effective = titleTransformAt(clip, currentFrame, project.fps, frame, geometry, clip.id === editingTitleId);
        return {
          clip,
          transform: effective.transform,
          layer: { rect: geometry.block, pivot: geometry.pivot },
          animation: effective.animation,
        };
      });
    // fontsLoaded: a title's box is measured again once its font is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.clips, project.tracks, project.fps, currentFrame, frame, editingTitleId, fontsLoaded]);

  /**
   * The clip being moved: one selected clip, with the transform mode on - or
   * a title, which moves without it, as Final Cut's do.
   *
   * Both conditions matter for any other clip. Final Cut asks for the mode
   * (Shift+T) and Premiere asks for the selection; wanting neither means
   * wanting to watch the picture, which is what a viewer is for.
   */
  const selected: Placed | null = useMemo(() => {
    if (selectedClipIds.length !== 1) return null;
    const found = visible.find((placed) => placed.clip.id === selectedClipIds[0]) ?? null;
    if (!found || (!transformMode && !found.clip.title)) return null;
    return found;
  }, [transformMode, selectedClipIds, visible]);
  /** Grips to scale and turn: the transform mode only. */
  const withGrips = transformMode && selected !== null;

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

  /** A title's animation taken back out: what is written is the keyframes, not the moment. */
  const toKeyframes = (placed: Placed, patch: { scale?: { x: number; y: number }; position?: { x: number; y: number } }) => {
    const animation = placed.animation;
    if (!animation) return patch;
    return {
      ...(patch.scale ? { scale: { x: patch.scale.x / animation.scale, y: patch.scale.y / animation.scale } } : {}),
      ...(patch.position ? { position: { x: patch.position.x - animation.offset.x, y: patch.position.y - animation.offset.y } } : {}),
    };
  };

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pointer = pointerToProject(event);
      const { placed } = drag;

      if (drag.kind === 'move') {
        const delta = { x: pointer.x - drag.startPointer.x, y: pointer.y - drag.startPointer.y };
        const wanted = movedPosition(drag.startTransform, delta);
        // The magnet, unless it is switched off or Alt asks for the exact
        // pixel under the pointer - the escape hatch every snap needs.
        const tolerance = snapping && !event.altKey ? SNAP_CSS_PX * projectPxPerCssPx : 0;
        const snap = placed.layer
          ? snappedTitlePosition(wanted, drag.startTransform, frame, placed.layer, tolerance, TITLE_SAFE)
          : { ...snappedPosition(wanted, drag.startTransform, frame, tolerance), safe: false };
        setGuides({ vertical: snap.vertical, horizontal: snap.horizontal, safe: snap.safe });
        // The same distance on the keyframed position, whatever the animation adds.
        setTransformAt(placed.clip.id, currentFrame, {
          position: {
            x: drag.basePosition.x + (snap.position.x - drag.startTransform.position.x),
            y: drag.basePosition.y + (snap.position.y - drag.startTransform.position.y),
          },
        });
        return;
      }
      if (drag.kind === 'scale') {
        // Scale and position together: the corner opposite the grip has to
        // stay where it is, and that is a move as well as a resize.
        setTransformAt(
          placed.clip.id,
          currentFrame,
          toKeyframes(placed, scaleFromHandle(drag.startTransform, drag.handle, pointer, frame, { free: event.shiftKey }, placed.layer)),
        );
        return;
      }
      setTransformAt(placed.clip.id, currentFrame, {
        rotation: rotationFromPointer(
          drag.startTransform,
          pointer,
          frame,
          { grabAngle: drag.grabAngle, snapDegrees: event.shiftKey ? ROTATION_SNAP_DEGREES : undefined },
          placed.layer,
        ),
      });
    },
    // toKeyframes reads only its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pointerToProject, setTransformAt, currentFrame, frame, snapping, projectPxPerCssPx],
  );

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setDragging(null);
    // The guides say "this is why it stopped here" during a drag; afterwards
    // they would just be lines across the picture.
    setGuides({ vertical: false, horizontal: false, safe: false });
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
      setDragging(drag.kind);
    },
    [],
  );

  const startMove = (event: ReactPointerEvent<SVGElement>, placed: Placed, pointer: Point): void => {
    // Only a clip that may move starts a drag: any clip in the transform
    // mode, a title always.
    if (!transformMode && !placed.clip.title) return;
    startDrag(event, {
      kind: 'move',
      startPointer: pointer,
      startTransform: placed.transform,
      basePosition: evaluateTransform(placed.clip.transform, currentFrame).position,
      placed,
    });
  };

  /** The topmost clip under the pointer: a title by its text, anything else by its picture. */
  const clipAt = (pointer: Point): Placed | null => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const placed = visible[i];
      if (containsPoint(placed.transform, pointer, frame, placed.layer)) return placed;
    }
    return null;
  };

  /** A press on the picture picks the clip under it, topmost first, and moves it. */
  const onSurfacePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const pointer = pointerToProject(event);
    if (editingTitleId) setUi({ editingTitleId: null });

    if (selected && containsPoint(selected.transform, pointer, frame, selected.layer)) {
      startMove(event, selected, pointer);
      return;
    }
    const hit = clipAt(pointer);
    if (hit) {
      setUi({ selectedClipIds: [hit.clip.id], selectedTrackId: hit.clip.trackId });
      startMove(event, hit, pointer);
      return;
    }
    setUi({ selectedClipIds: [] });
  };

  /** A double-click on a title types into it, where it is. */
  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (playing) return;
    const hit = clipAt(pointerToProject(event));
    if (!hit?.clip.title) return;
    event.preventDefault();
    setUi({ selectedClipIds: [hit.clip.id], selectedTrackId: hit.clip.trackId, editingTitleId: hit.clip.id });
  };

  // An edit ends when its title leaves the playhead or the selection.
  useEffect(() => {
    if (!editingTitleId) return;
    const stillThere = visible.some((placed) => placed.clip.id === editingTitleId);
    if (!stillThere || selectedClipIds[0] !== editingTitleId || playing) setUi({ editingTitleId: null });
  }, [editingTitleId, visible, selectedClipIds, playing, setUi]);

  if (project.width === 0 || project.height === 0) return null;

  const handleSize = HANDLE_CSS_PX * projectPxPerCssPx;
  const stroke = 1 * projectPxPerCssPx;
  const corners = selected ? quadCorners(selected.transform, frame, selected.layer) : [];
  const grips = withGrips && selected ? handlePositions(selected.transform, frame, selected.layer) : null;
  const pivot = withGrips && selected ? anchorPosition(selected.transform, frame, selected.layer) : null;
  const rotateGrip =
    grips && pivot
      ? (() => {
          const away = { x: grips.top.x - pivot.x, y: grips.top.y - pivot.y };
          const size = Math.hypot(away.x, away.y) || 1;
          const reach = ROTATE_ARM_CSS_PX * projectPxPerCssPx;
          return { x: grips.top.x + (away.x / size) * reach, y: grips.top.y + (away.y / size) * reach };
        })()
      : null;

  const editing = editingTitleId ? visible.find((placed) => placed.clip.id === editingTitleId && placed.clip.title) : undefined;
  const safeX = (project.width * (1 - TITLE_SAFE)) / 2;
  const safeY = (project.height * (1 - TITLE_SAFE)) / 2;

  return (
    <>
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
        onDoubleClick={onDoubleClick}
      >
        {/* The title-safe area, while a title is being moved: where its text belongs. */}
        {dragging === 'move' && dragRef.current?.placed.layer && (
          <rect
            data-testid="viewport-safe-area"
            x={safeX}
            y={safeY}
            width={project.width - safeX * 2}
            height={project.height - safeY * 2}
            fill="none"
            stroke={guides.safe ? '#f472b6' : 'rgba(255, 255, 255, 0.55)'}
            strokeWidth={stroke}
            strokeDasharray={`${6 * projectPxPerCssPx} ${4 * projectPxPerCssPx}`}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}

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

        {selected && corners.length === 4 && !editing && (
          <g data-testid={selected.layer ? 'viewport-title-box' : undefined}>
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

            {grips && rotateGrip && (
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
                      grabAngle: angleAround(selected.transform, pointerToProject(event), frame, selected.layer),
                      startTransform: selected.transform,
                      placed: selected,
                    })
                  }
                />
              </>
            )}

            {grips &&
              [...CORNER_HANDLES, ...EDGE_HANDLES].map((handle) => {
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
                    onPointerDown={(event) => startDrag(event, { kind: 'scale', handle, startTransform: selected.transform, placed: selected })}
                  />
                );
              })}

            {/* The anchor: what the clip turns and scales about. */}
            {pivot && (
              <g pointerEvents="none" data-testid="viewport-pivot">
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

      {editing?.clip.title && editing.layer && (
        <TitleTextEditor
          key={editing.clip.id}
          clip={editing.clip}
          layout={titleLayout(editing.clip.title, frame)}
          frame={frame}
          // Title pixels to the picture on screen: the compositor's own sum,
          // then project pixels to CSS pixels.
          matrix={layerToPixels(editing.transform, frame, editing.layer).map((value) => value / projectPxPerCssPx) as [number, number, number, number, number, number]}
          onDone={() => setUi({ editingTitleId: null })}
        />
      )}
    </>
  );
}

export default ViewportControls;
