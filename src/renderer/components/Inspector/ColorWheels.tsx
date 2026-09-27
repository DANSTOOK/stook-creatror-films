import { useId, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import {
  WHEEL_RANGE,
  WHEELS,
  neutralWheel,
  puckOf,
  wheelFrom,
  wheelMaster,
  withMaster,
  withPuck,
  type Rgb,
  type WheelId,
} from '@renderer/color/grade';

/**
 * The primaries: four colour wheels in a 2 x 2 grid, as Resolve lays out
 * Lift, Gamma, Gain and Offset and Final Cut its Shadows, Midtones,
 * Highlights and Global.
 *
 * Each wheel is two controls over the same three numbers (color/grade.ts):
 *
 *   - the puck, dragged inside the wheel, sets the colour. It moves with the
 *     pointer rather than jumping to it, as Resolve's does, and Shift slows it
 *     to a fifth for fine work. Its directions are the vectorscope's: up is
 *     toward red, right toward blue.
 *   - the slider under it sets the brightness, without touching the colour.
 *
 * Double-click either one to put it back. The keyboard moves the puck with
 * the arrows (Shift for bigger steps) and puts it back with Delete or Home.
 * "Numbers" shows the same values as fields - Y, R, G, B - for exact work,
 * as Resolve's Primaries Bars do.
 */

export type WheelMode = 'wheels' | 'numbers';

type WheelKey = 'grade.lift' | 'grade.gamma' | 'grade.gain' | 'grade.offset';
type HintKey = 'grade.liftHint' | 'grade.gammaHint' | 'grade.gainHint' | 'grade.offsetHint';
const NAME: Record<WheelId, WheelKey> = { lift: 'grade.lift', gamma: 'grade.gamma', gain: 'grade.gain', offset: 'grade.offset' };
const HINT: Record<WheelId, HintKey> = { lift: 'grade.liftHint', gamma: 'grade.gammaHint', gain: 'grade.gainHint', offset: 'grade.offsetHint' };

/** Where the puck moves per arrow key, in wheel radii. */
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;
/** Shift while dragging: the puck moves at this fraction of the pointer. */
const FINE = 0.2;

const signed = (value: number): string => `${value > 0.004 ? '+' : ''}${value.toFixed(2)}`;
const clamp = (value: number): number => Math.min(WHEEL_RANGE, Math.max(-WHEEL_RANGE, value));

/*
  The ring: the colour a push in each direction gives, so the wheel shows
  where its colours are. CSS conic gradients start at the top and go
  clockwise; the wheel's directions are the vectorscope's (Cb right, Cr up).
*/
const RING = (() => {
  const stops: string[] = [];
  for (let degrees = 0; degrees <= 360; degrees += 15) {
    const theta = ((90 - degrees) * Math.PI) / 180;
    const [r, g, b] = wheelFrom(0, Math.cos(theta) * 0.3, Math.sin(theta) * 0.3);
    const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, 0.55 + value)) * 255);
    stops.push(`rgb(${channel(r)} ${channel(g)} ${channel(b)}) ${degrees}deg`);
  }
  return `conic-gradient(${stops.join(', ')})`;
})();

export function ColorWheels({
  values,
  mode,
  onChange,
}: {
  values: Record<WheelId, Rgb>;
  mode: WheelMode;
  onChange(wheel: WheelId, value: Rgb): void;
}): JSX.Element {
  return (
    <div data-testid="color-wheels" data-mode={mode} className="grid grid-cols-2 gap-x-3 gap-y-3">
      {WHEELS.map((wheel) => (
        <Wheel key={wheel} wheel={wheel} value={values[wheel]} mode={mode} onChange={(value) => onChange(wheel, value)} />
      ))}
    </div>
  );
}

function Wheel({ wheel, value, mode, onChange }: { wheel: WheelId; value: Rgb; mode: WheelMode; onChange(value: Rgb): void }): JSX.Element {
  const t = useT();
  const name = t(NAME[wheel]);
  const hint = t(HINT[wheel]);
  const master = wheelMaster(value);
  const puck = puckOf(value);
  const sliderId = useId();

  // The latest value, for a drag that outlives the render it started in.
  const latest = useRef(value);
  latest.current = value;
  const drag = useRef<{ x: number; y: number; puck: { x: number; y: number }; radius: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const box = event.currentTarget.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, puck: puckOf(latest.current), radius: Math.max(1, box.width / 2) };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start) return;
    const speed = event.shiftKey ? FINE : 1;
    const x = start.puck.x + ((event.clientX - start.x) / start.radius) * speed;
    const y = start.puck.y - ((event.clientY - start.y) / start.radius) * speed;
    onChange(withPuck(latest.current, x, y));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    // The keys a wheel uses stop here: on the window the arrows step the
    // playhead, and Delete deletes the selected clip - the one being graded.
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      onChange(withPuck(value, puck.x + move[0], puck.y + move[1]));
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      onChange(withPuck(value, 0, 0));
    }
  };

  const readout = `R ${signed(value[0])}  G ${signed(value[1])}  B ${signed(value[2])}`;

  return (
    <div data-testid={`wheel-${wheel}`} className="flex min-w-0 flex-col items-stretch gap-1.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className="field-label truncate" {...tip(hint, { named: false })}>
          {name}
        </span>
        <span className="timecode text-2xs text-slate-400" aria-hidden>
          {signed(master)}
        </span>
      </div>

      {mode === 'wheels' ? (
        <>
          <div
            role="slider"
            tabIndex={0}
            aria-roledescription={t('grade.wheelRole')}
            aria-label={t('grade.wheel', { name })}
            aria-valuemin={-1}
            aria-valuemax={1}
            aria-valuenow={Number(Math.hypot(puck.x, puck.y).toFixed(2))}
            aria-valuetext={readout}
            data-testid={`wheel-${wheel}-disc`}
            className="relative mx-auto aspect-square w-full max-w-[116px] cursor-crosshair touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
            style={{ background: RING }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => onChange(withPuck(latest.current, 0, 0))}
            onKeyDown={onKeyDown}
            {...tip(`${hint} ${t('grade.resetHint')}`, { named: false })}
          >
            {/* The dark face, with its cross, inside the ring of colours. */}
            <div aria-hidden className="absolute inset-[5px] rounded-full bg-panel-950">
              <div className="absolute inset-x-2 top-1/2 h-px bg-white/10" />
              <div className="absolute inset-y-2 left-1/2 w-px bg-white/10" />
              <div className="absolute inset-[30%] rounded-full border border-white/10" />
            </div>
            <span
              aria-hidden
              data-testid={`wheel-${wheel}-puck`}
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-panel-950 shadow"
              style={{
                left: `calc(50% + ${puck.x} * (50% - 11px))`,
                top: `calc(50% - ${puck.y} * (50% - 11px))`,
              }}
            />
          </div>
          <label className="sr-only" htmlFor={sliderId}>
            {t('grade.brightness', { name })}
          </label>
          <input
            id={sliderId}
            data-testid={`wheel-${wheel}-master`}
            type="range"
            className="min-w-0"
            min={-WHEEL_RANGE}
            max={WHEEL_RANGE}
            step={0.01}
            value={master}
            onChange={(event) => onChange(withMaster(latest.current, Number(event.target.value)))}
            onDoubleClick={() => onChange(withMaster(latest.current, 0))}
            {...tip(`${t('grade.brightness', { name })}. ${t('grade.resetHint')}`, { named: false })}
          />
          <span className="timecode truncate text-center text-2xs text-slate-400">{readout}</span>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-1">
          {(['y', 'r', 'g', 'b'] as const).map((channel) => {
            const current = channel === 'y' ? master : value[channel === 'r' ? 0 : channel === 'g' ? 1 : 2];
            return (
              <label key={channel} className="flex min-w-0 items-center gap-1 text-2xs text-slate-400">
                <span aria-hidden className="w-2.5 uppercase">{channel}</span>
                <input
                  type="number"
                  data-testid={`wheel-${wheel}-${channel}`}
                  aria-label={`${name} ${channel.toUpperCase()}`}
                  className="numeric-input timecode h-control-dense min-w-0 flex-1 px-1 text-right"
                  min={-WHEEL_RANGE}
                  max={WHEEL_RANGE}
                  step={0.01}
                  value={Number(current.toFixed(3))}
                  onChange={(event) => {
                    const typed = clamp(Number(event.target.value));
                    if (!Number.isFinite(typed)) return;
                    if (channel === 'y') {
                      onChange(withMaster(latest.current, typed));
                      return;
                    }
                    const next: Rgb = [...latest.current];
                    next[channel === 'r' ? 0 : channel === 'g' ? 1 : 2] = typed;
                    onChange(next);
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const neutralWheels = (): Record<WheelId, Rgb> => ({
  lift: neutralWheel(),
  gamma: neutralWheel(),
  gain: neutralWheel(),
  offset: neutralWheel(),
});
