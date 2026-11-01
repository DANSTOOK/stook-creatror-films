import { useCallback, useEffect, useRef } from 'react';
import type { Stroke } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useDrawStore } from '@renderer/animation/drawStore';
import { exposureAt, frameOfExposure, newId } from '@renderer/animation/model';
import { drawStroke } from '@renderer/animation/raster';
import { drawKeyOf, nextDrawing, previousDrawing } from '@renderer/animation/keys';
import { isRealDrag, shapePoints } from '@renderer/animation/shapes';

/**
 * Drawing on the picture.
 *
 * The stroke under the hand is drawn on a canvas of this overlay's own, not
 * through the project: a line must appear under the pointer at once, and
 * putting every pointer move through the store - and so through the
 * compositor, and through undo - would make the line lag behind the hand and
 * fill the history with hundreds of steps.
 *
 * It is committed once, on letting go, as ONE undo step. Then the overlay's
 * canvas is cleared and the stroke appears in the picture proper, drawn by the
 * compositor like everything else. The handover is invisible because both
 * draw the same stroke the same way, from `animation/raster`.
 */

/** Points closer together than this (in frame fractions) are not worth keeping. */
const MIN_STEP = 0.0015;

export function DrawOverlay(): JSX.Element | null {
  const clipId = useDrawStore((state) => state.clipId);
  const layerId = useDrawStore((state) => state.layerId);
  const mode = useDrawStore((state) => state.mode);
  const tool = useDrawStore((state) => state.tool);
  const sides = useDrawStore((state) => state.sides);
  const brush = useDrawStore((state) => state.brush);
  const color = useDrawStore((state) => state.color);
  const size = useDrawStore((state) => state.size);
  const opacity = useDrawStore((state) => state.opacity);
  const stop = useDrawStore((state) => state.stop);
  const pick = useDrawStore((state) => state.pick);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const width = useProjectStore((state) => state.project.width);
  const height = useProjectStore((state) => state.project.height);
  const commit = useProjectStore((state) => state.drawStroke);

  const canvas = useRef<HTMLCanvasElement>(null);
  /** The stroke being drawn, as x, y, pressure triplets. Not state: it changes per pointer event. */
  const points = useRef<number[]>([]);
  const drawing = useRef(false);
  /** Where a shape drag began, and whether Shift was down at the last move. */
  const origin = useRef<{ x: number; y: number } | null>(null);
  const even = useRef(false);

  // The tool puts itself away when its clip is gone, so a deleted animation
  // cannot leave a live canvas over the picture.
  useEffect(() => {
    if (clipId && !clip?.anim) stop();
  }, [clipId, clip, stop]);

  // Escape puts the brush away, and the brush’s own keys work while it is in
  // hand: `[` and `]` for width, `,` and `.` between drawings, E and P for the
  // eraser and the pencil. They are a tool’s keys and live only here, so the
  // editor keeps its own the moment the brush is put down.
  useEffect(() => {
    if (!clipId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        stop();
        return;
      }
      // Typing somewhere keeps its letters: a layer being renamed is not a brush.
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const meant = drawKeyOf(event);
      if (!meant) return;
      const state = useProjectStore.getState();
      const clip = state.project.clips[clipId];
      if (!clip?.anim) return;
      event.preventDefault();
      event.stopPropagation();
      if (meant.kind === 'brush') {
        pick({ brush: meant.brush });
        return;
      }
      if (meant.kind === 'size') {
        pick({ size: useDrawStore.getState().size * meant.by });
        return;
      }
      const anim = clip.anim;
      const wanted = useDrawStore.getState().layerId ?? anim.layers[anim.layers.length - 1]?.id;
      const layer = anim.layers.find((candidate) => candidate.id === wanted);
      const here = exposureAt(anim, clip, state.project.currentFrame);
      const to = meant.by === 1 ? nextDrawing(anim, clip, layer, here) : previousDrawing(layer, here);
      state.setCurrentFrame(frameOfExposure(anim, clip, to));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId, stop, pick]);

  const clear = useCallback((): void => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx && canvas.current) ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
  }, []);

  /** The live stroke as it stands, which is what both this canvas and the project draw. */
  const liveStroke = useCallback(
    (): Stroke => ({ id: 'live', brush, color, size, opacity, points: [...points.current] }),
    [brush, color, size, opacity],
  );

  const repaint = useCallback((): void => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    if (points.current.length < 3) return;
    // An eraser cannot be previewed by taking pixels away - there is nothing
    // on this canvas to take away - so it is shown as a grey line, which is
    // what it will remove.
    const shown = brush === 'eraser' ? { ...liveStroke(), brush: 'marker' as const, color: '#94a3b8', opacity: 0.5 } : liveStroke();
    drawStroke(ctx, shown, element.width, element.height);
  }, [brush, liveStroke]);

  const at = (event: React.PointerEvent): { x: number; y: number; pressure: number } => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0, pressure: 0.5 };
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      // A mouse reports 0.5 while down, a pen reports what it feels, and a
      // device that reports nothing must still draw: 0.5 either way.
      pressure: event.pressure > 0 && event.pressure !== 0.5 ? event.pressure : 0.5,
    };
  };

  const begin = (event: React.PointerEvent): void => {
    if (!clipId || !clip?.anim) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = at(event);
    drawing.current = true;
    origin.current = { x: point.x, y: point.y };
    even.current = event.shiftKey;
    points.current = [point.x, point.y, point.pressure];
    repaint();
  };

  const move = (event: React.PointerEvent): void => {
    if (!drawing.current) return;
    const point = at(event);
    // A shape is REBUILT from where the drag began to where it is now, not
    // accumulated: dragging back makes it smaller, as a shape tool should.
    if (tool !== 'freehand' && origin.current) {
      even.current = event.shiftKey;
      points.current = isRealDrag(origin.current, point)
        ? shapePoints({ kind: tool, from: origin.current, to: point, sides, even: even.current })
        : [];
      repaint();
      return;
    }
    const last = points.current.length;
    // Points the hand did not really move between are dropped: a stroke of
    // 2000 points draws no better than one of 200 and makes the file four
    // times the size.
    if (last >= 3 && Math.hypot(point.x - points.current[last - 3], point.y - points.current[last - 2]) < MIN_STEP) return;
    points.current.push(point.x, point.y, point.pressure);
    repaint();
  };

  const end = (): void => {
    if (!drawing.current) return;
    drawing.current = false;
    origin.current = null;
    const drawn = points.current;
    points.current = [];
    if (!clipId || !clip?.anim || drawn.length < 3) {
      clear();
      return;
    }
    const target = layerId ?? clip.anim.layers[clip.anim.layers.length - 1]?.id;
    if (!target) {
      clear();
      return;
    }
    const exposure = exposureAt(clip.anim, clip, currentFrame);
    commit(clipId, target, exposure, { id: newId('stroke'), brush, color, size, opacity, points: drawn });
    // Cleared only after the project has it, so the line never blinks out.
    clear();
  };

  // The animate tool has the pointer instead (AnimateOverlay); two canvases
  // both taking the drag would fight.
  if (!clipId || !clip?.anim || mode === 'animate') return null;

  return (
    <canvas
      ref={canvas}
      data-testid="draw-overlay"
      width={width}
      height={height}
      className="absolute inset-0 z-20 block h-full w-full cursor-crosshair"
      style={{ touchAction: 'none' }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
    />
  );
}
