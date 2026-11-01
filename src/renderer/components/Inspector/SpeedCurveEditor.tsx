import { useRef, useState } from 'react';
import { useT } from '@renderer/i18n';
import { MAX_SPEED, MIN_SPEED, SPEED_RAMPS, speedAlong } from '@renderer/timing/clipSpeed';
import type { SpeedRampPreset } from '@shared/types';

/**
 * A speed curve dragged by hand: nine points along the clip, each a relative
 * speed, joined by straight lines - the same shape the ready-made ramps are,
 * so the retiming maths is theirs and nothing new had to be invented for it
 * (timing/clipSpeed).
 *
 * Nine because that is what the presets use and what the drawing already
 * assumed; more handles on a panel this narrow would be smaller than a
 * fingertip, and fewer could not express "fast, a held moment, fast".
 *
 * Dragged in SVG user units rather than pixels, so the maths is the same
 * whatever width the panel is. A point moves up and down only: moving them
 * sideways as well would mean points could cross, and a curve whose points are
 * out of order is not a function of time.
 *
 * The clip's own length never changes, however the curve is pulled about: the
 * average speed is still the clip's `speed`, so a ramp only moves which frame
 * is shown when. That is what the ramps do and what makes a curve safe to drag
 * while watching.
 */

/** The drawing's box, in user units. */
const BOX = { width: 240, height: 96, pad: 8 };
/** What the top of the box means, so a curve has somewhere to go. */
const CEILING = 5;

export interface SpeedCurveEditorProps {
  /** The curve as it stands: the clip's own, or a preset's to start from. */
  points: readonly number[];
  disabled?: boolean;
  onChange(points: number[]): void;
}

const clampSpeed = (value: number): number => Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));

/** Where a point sits in the box. */
const place = (points: readonly number[], index: number): { x: number; y: number } => ({
  x: BOX.pad + (index / (points.length - 1)) * (BOX.width - BOX.pad * 2),
  y: BOX.height - BOX.pad - (Math.min(points[index], CEILING) / CEILING) * (BOX.height - BOX.pad * 2),
});

/** The speed a height in the box means. */
const speedAt = (y: number): number =>
  clampSpeed(((BOX.height - BOX.pad - y) / (BOX.height - BOX.pad * 2)) * CEILING);

export function SpeedCurveEditor({ points, disabled, onChange }: SpeedCurveEditorProps): JSX.Element {
  const t = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  /**
   * A pointer's place in the drawing's own units.
   *
   * Through the SVG’s own matrix rather than by scaling the bounding box: with
   * the default preserveAspectRatio the viewBox is FITTED inside the element and
   * centred, so on a panel wider than 240:96 there are bars at the sides and a
   * straight proportion across the box lands somewhere else entirely. Measured:
   * a drag moved the handle nowhere at all.
   */
  const atPointer = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const inside = point.matrixTransform(matrix.inverse());
    return { x: inside.x, y: inside.y };
  };

  const move = (index: number, event: { clientX: number; clientY: number }): void => {
    const at = atPointer(event);
    if (!at) return;
    const next = [...points];
    next[index] = Math.round(speedAt(at.y) * 100) / 100;
    onChange(next);
  };

  const line = points.map((_value, index) => {
    const { x, y } = place(points, index);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const unity = BOX.height - BOX.pad - (1 / CEILING) * (BOX.height - BOX.pad * 2);

  return (
    <div className="flex flex-col gap-1">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        data-testid="speed-curve"
        role="group"
        aria-label={t('ramp.curve')}
        className={`h-24 w-full touch-none rounded-control border border-panel-700 bg-panel-950 ${disabled ? 'opacity-50' : ''}`}
        onPointerMove={(event) => {
          if (dragging === null || disabled) return;
          event.preventDefault();
          move(dragging, event);
        }}
        onPointerUp={(event) => {
          svgRef.current?.releasePointerCapture?.(event.pointerId);
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
      >
        {/* 1x, so "faster" and "slower" are read against something. */}
        <line x1={BOX.pad} x2={BOX.width - BOX.pad} y1={unity} y2={unity} className="stroke-slate-600" strokeDasharray="3 3" strokeWidth="1" />
        <polyline points={line} fill="none" className="stroke-accent-hover" strokeWidth="2" strokeLinejoin="round" />
        {points.map((value, index) => {
          const { x, y } = place(points, index);
          return (
            <circle
              key={index}
              cx={x}
              cy={y}
              r={dragging === index ? 7 : 5}
              data-testid={`speed-curve-point-${index}`}
              className={`${disabled ? 'fill-slate-600' : 'cursor-ns-resize fill-accent'} stroke-panel-950`}
              strokeWidth="1.5"
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={t('ramp.curvePoint', { index: index + 1, speed: value.toFixed(2) })}
              aria-valuenow={value}
              aria-valuemin={MIN_SPEED}
              aria-valuemax={MAX_SPEED}
              onPointerDown={(event) => {
                if (disabled) return;
                event.preventDefault();
                // Captured on the SVG, not the handle: the moves then keep arriving
                // even when the pointer leaves the box, and a drag that starts on a
                // 5-unit circle is not lost the moment it moves off it.
                svgRef.current?.setPointerCapture(event.pointerId);
                setDragging(index);
              }}
              onKeyDown={(event) => {
                if (disabled) return;
                // The keyboard moves a point too: a curve must not need a mouse.
                const step = event.shiftKey ? 0.5 : 0.1;
                const delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
                if (delta === 0) return;
                event.preventDefault();
                const next = [...points];
                next[index] = Math.round(clampSpeed(value + delta) * 100) / 100;
                onChange(next);
              }}
            />
          );
        })}
      </svg>
      <p className="text-2xs leading-relaxed text-slate-400">
        {t('ramp.curveHint', { fastest: Math.max(...points).toFixed(2), slowest: Math.min(...points).toFixed(2) })}
      </p>
    </div>
  );
}

/** A preset's points, to start a curve from. */
export const pointsOfPreset = (preset: SpeedRampPreset | null): number[] =>
  preset ? [...SPEED_RAMPS[preset]] : [1, 1, 1, 1, 1, 1, 1, 1, 1];

/** The speed a curve reaches at `u`, for anything that wants to show it. */
export const curveSpeedAt = speedAlong;
