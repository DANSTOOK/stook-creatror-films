import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { CurvePoint } from '@shared/types';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import {
  LEVEL_CURVES,
  OFFSET_RANGE,
  curveFunction,
  isPeriodic,
  type CurveId,
  type OffsetCurve,
} from '@renderer/color/curves';

/**
 * One curve, drawn and edited: Resolve's curve editor at the size of a panel.
 *
 *   - click on the curve's area to add a point there, and keep dragging it;
 *   - drag a point; it cannot pass its neighbours, and the two ends of a
 *     level curve slide only up and down;
 *   - double-click a point, or focus it and press Delete, to take it away;
 *   - from the keyboard: Tab to a point, arrows to move it (Shift for a
 *     bigger step); with the editor itself focused, Enter adds a point in
 *     the widest gap.
 *
 * The first point put on an empty hue curve brings two flat neighbours with
 * it, a sixth of a turn to either side, as Resolve's colour picker does: a
 * lone point would move every hue at once, which is not what pulling red
 * means.
 *
 * Every key the editor uses stops here. The editor's shortcuts listen on the
 * window, where Delete deletes the selected clip and the arrows move the
 * playhead - the clip being graded, the frame being looked at.
 */

const MIN_GAP = 0.01;
const ANCHOR = 1 / 6;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const isLevel = (curve: CurveId): boolean => (LEVEL_CURVES as readonly string[]).includes(curve);

/** The colour of a level curve's line; the others are drawn in the text colour. */
const STROKE: Partial<Record<CurveId, string>> = { red: '#f87171', green: '#4ade80', blue: '#60a5fa' };

/** The full circle of hues, left to right, for the hue curves' strip. */
const HUE_STRIP = 'linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%)';

export function CurveEditor({
  curve,
  points,
  label,
  onChange,
}: {
  curve: CurveId;
  points: CurvePoint[];
  label: string;
  onChange(points: CurvePoint[]): void;
}): JSX.Element {
  const t = useT();
  const level = isLevel(curve);
  const range = level ? 1 : OFFSET_RANGE[curve as OffsetCurve];
  const boxRef = useRef<HTMLDivElement>(null);
  const pointRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const drag = useRef<number | null>(null);
  const latest = useRef(points);
  latest.current = points;
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  /* Where things are: 0..1 across, and up for the value. */
  const toTop = (y: number): number => (level ? 1 - y : 0.5 - y / (2 * range));
  const fromPointer = (clientX: number, clientY: number): CurvePoint => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    const x = clamp((clientX - box.left) / box.width, 0, isPeriodic(curve) ? 0.9999 : 1);
    const top = clamp((clientY - box.top) / box.height, 0, 1);
    return { x, y: level ? 1 - top : (0.5 - top) * 2 * range };
  };

  const path = useMemo(() => {
    const sample = curveFunction(curve, points);
    const steps = 128;
    const coordinates: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = i / steps;
      const y = clamp(sample(x), level ? 0 : -range, level ? 1 : range);
      coordinates.push(`${(x * 1000).toFixed(1)},${(toTop(y) * 1000).toFixed(1)}`);
    }
    return coordinates.join(' ');
    // toTop depends only on the curve kind, already in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, points, level, range]);

  /** Put point `index` at `target`, kept between its neighbours. */
  const moved = (current: CurvePoint[], index: number, target: CurvePoint): CurvePoint[] => {
    const next = current.map((point) => ({ ...point }));
    const endpoint = level && (index === 0 || index === current.length - 1);
    const low = index > 0 ? current[index - 1].x + MIN_GAP : 0;
    const high = index < current.length - 1 ? current[index + 1].x - MIN_GAP : isPeriodic(curve) ? 0.9999 : 1;
    next[index] = {
      x: endpoint ? current[index].x : clamp(target.x, low, Math.max(low, high)),
      y: clamp(target.y, level ? 0 : -range, level ? 1 : range),
    };
    return next;
  };

  /** Add a point, and its two flat neighbours on an empty offset curve. Returns the new list and its index. */
  const added = (current: CurvePoint[], point: CurvePoint): { points: CurvePoint[]; index: number } => {
    const next = [...current];
    if (!level && current.length === 0) {
      const wrap = isPeriodic(curve);
      const around = [point.x - ANCHOR, point.x + ANCHOR].map((x) => (wrap ? x - Math.floor(x) : clamp(x, 0, 1)));
      for (const x of around) if (Math.abs(x - point.x) > MIN_GAP) next.push({ x, y: 0 });
    }
    // No two points closer than the minimum gap: a click on an existing point's
    // column moves that point instead.
    const near = next.findIndex((existing) => Math.abs(existing.x - point.x) < MIN_GAP);
    if (near >= 0) {
      const replaced = { x: next[near].x, y: point.y };
      next[near] = replaced;
      next.sort((a, b) => a.x - b.x);
      return { points: next, index: next.indexOf(replaced) };
    }
    next.push(point);
    next.sort((a, b) => a.x - b.x);
    return { points: next, index: next.indexOf(point) };
  };

  const removed = (current: CurvePoint[], index: number): CurvePoint[] => {
    if (level && (index === 0 || index === current.length - 1)) return current;
    return current.filter((_, i) => i !== index);
  };

  /* Pointer --------------------------------------------------------------- */

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const pointIndex = target.dataset.pointIndex === undefined ? -1 : Number(target.dataset.pointIndex);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointIndex >= 0) {
      drag.current = pointIndex;
      pointRefs.current[pointIndex]?.focus();
      return;
    }
    const { points: next, index } = added(latest.current, fromPointer(event.clientX, event.clientY));
    onChange(next);
    drag.current = index;
    setFocusIndex(index);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    onChange(moved(latest.current, drag.current, fromPointer(event.clientX, event.clientY)));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /* Keyboard -------------------------------------------------------------- */

  const onPointKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step * (level ? 1 : range)],
      ArrowDown: [0, -step * (level ? 1 : range)],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      const point = points[index];
      onChange(moved(points, index, { x: point.x + move[0], y: point.y + move[1] }));
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      const next = removed(points, index);
      if (next !== points) {
        onChange(next);
        const following = Math.min(index, next.length - 1);
        setFocusIndex(following >= 0 ? following : null);
        if (following < 0) boxRef.current?.focus();
      }
    }
  };
  const onBoxKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    // The middle of the widest gap, at the curve's own value there.
    const xs = [0, ...points.map((point) => point.x), 1];
    let best = 0;
    for (let i = 1; i < xs.length - 1; i += 1) if (xs[i + 1] - xs[i] > xs[best + 1] - xs[best]) best = i;
    const x = (xs[best] + xs[best + 1]) / 2;
    const { points: next, index } = added(points, { x, y: curveFunction(curve, points)(x) });
    onChange(next);
    setFocusIndex(index);
  };

  // A point just added or kept after a removal takes the focus.
  const focusRef = (index: number) => (element: HTMLButtonElement | null) => {
    pointRefs.current[index] = element;
    if (element && focusIndex === index) {
      element.focus();
      setFocusIndex(null);
    }
  };

  const describe = (point: CurvePoint): string =>
    isPeriodic(curve)
      ? `${Math.round(point.x * 360)}°, ${point.y >= 0 ? '+' : ''}${point.y.toFixed(2)}`
      : `${point.x.toFixed(2)}, ${point.y >= 0 && !level ? '+' : ''}${point.y.toFixed(2)}`;

  return (
    <div
      ref={boxRef}
      role="group"
      tabIndex={0}
      aria-label={t('curves.editor', { name: label })}
      data-testid={`curve-${curve}`}
      className="relative h-36 w-full cursor-crosshair touch-none select-none rounded-control border border-panel-700 bg-panel-950 outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onBoxKey}
      {...tip(t('curves.editorHint'), { named: false })}
    >
      {/* The grid, and what the curve does nothing along. */}
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        {[250, 500, 750].map((at) => (
          <g key={at} stroke="rgba(255,255,255,0.08)" strokeWidth={1} vectorEffect="non-scaling-stroke">
            <line x1={at} y1={0} x2={at} y2={1000} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={at} x2={1000} y2={at} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {level ? (
          <line x1={0} y1={1000} x2={1000} y2={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        ) : (
          <line x1={0} y1={500} x2={1000} y2={500} stroke="rgba(255,255,255,0.22)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        <polyline points={path} fill="none" stroke={STROKE[curve] ?? '#e2e8f0'} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Along the bottom: what is across - the hues, or the levels. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 rounded-b-control opacity-80"
        style={{ background: isPeriodic(curve) ? HUE_STRIP : 'linear-gradient(to right, #000, #fff)' }}
      />
      {points.map((point, index) => (
        <button
          key={index}
          ref={focusRef(index)}
          type="button"
          data-point-index={index}
          data-testid={`curve-${curve}-point-${index}`}
          aria-label={t('curves.point', { n: index + 1, value: describe(point) })}
          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-panel-950 outline-none transition-transform duration-[var(--dur-micro)] hover:scale-125 focus-visible:ring-2 focus-visible:ring-accent-hover motion-reduce:transition-none"
          style={{ left: `${point.x * 100}%`, top: `${toTop(point.y) * 100}%` }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onChange(removed(latest.current, index));
          }}
          onKeyDown={(event) => onPointKey(event, index)}
        />
      ))}
    </div>
  );
}
