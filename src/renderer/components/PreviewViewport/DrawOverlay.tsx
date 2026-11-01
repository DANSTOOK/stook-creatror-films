import { useCallback, useEffect, useRef } from 'react';
import type { Stroke } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useDrawStore } from '@renderer/animation/drawStore';
import { exposureAt, newId } from '@renderer/animation/model';
import { drawStroke } from '@renderer/animation/raster';

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
  const brush = useDrawStore((state) => state.brush);
  const color = useDrawStore((state) => state.color);
  const size = useDrawStore((state) => state.size);
  const opacity = useDrawStore((state) => state.opacity);
  const stop = useDrawStore((state) => state.stop);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const width = useProjectStore((state) => state.project.width);
  const height = useProjectStore((state) => state.project.height);
  const commit = useProjectStore((state) => state.drawStroke);

  const canvas = useRef<HTMLCanvasElement>(null);
  /** The stroke being drawn, as x, y, pressure triplets. Not state: it changes per pointer event. */
  const points = useRef<number[]>([]);
  const drawing = useRef(false);

  // The tool puts itself away when its clip is gone, so a deleted animation
  // cannot leave a live canvas over the picture.
  useEffect(() => {
    if (clipId && !clip?.anim) stop();
  }, [clipId, clip, stop]);

  useEffect(() => {
    if (!clipId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId, stop]);

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
    points.current = [point.x, point.y, point.pressure];
    repaint();
  };

  const move = (event: React.PointerEvent): void => {
    if (!drawing.current) return;
    const point = at(event);
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

  if (!clipId || !clip?.anim) return null;

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
