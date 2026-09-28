import { useId, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronRight, RotateCcw, X } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';

/**
 * The inspector's building blocks: label-left, value-right rows whose label
 * can be dragged to change the number, and the foldable sections they sit
 * in. Shared by every inspector tab, the title's included.
 */

export const plain = (value: number): string => value.toFixed(2);
/* Rows -------------------------------------------------------------------- */

/**
 * A label that changes its number when dragged sideways: a pixel of travel is
 * one step, Shift a tenth of one, Alt ten. Pointer capture keeps the drag when
 * the pointer leaves the label.
 */
export function ScrubLabel({
  htmlFor,
  children,
  value,
  step,
  onChange,
  className = '',
}: {
  htmlFor: string;
  children: ReactNode;
  value: number;
  step: number;
  onChange(value: number): void;
  className?: string;
}): JSX.Element {
  const origin = useRef<{ x: number; value: number } | null>(null);
  /** Set when the pointer travelled: the click that ends a drag must not focus the field. */
  const dragged = useRef(false);
  return (
    <label
      htmlFor={htmlFor}
      className={`cursor-ew-resize select-none touch-none ${className}`}
      onPointerDown={(event: ReactPointerEvent<HTMLLabelElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = { x: event.clientX, value };
        dragged.current = false;
      }}
      onClick={(event) => {
        // A plain click on the label still puts the caret in its field.
        if (dragged.current) event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!origin.current) return;
        if (Math.abs(event.clientX - origin.current.x) > 2) dragged.current = true;
        const scale = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
        const next = origin.current.value + (event.clientX - origin.current.x) * step * scale;
        onChange(Number(next.toFixed(4)));
      }}
      onPointerUp={(event) => {
        origin.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      {children}
    </label>
  );
}

export interface NumberInputProps {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number, inside the field: "%", "px", "°". */
  unit?: string;
  /** Displayed value = stored value x this; typing divides it back out. */
  factor?: number;
  label?: string;
  onChange(value: number): void;
}

export function NumberInput({ id, value, min, max, step = 0.01, unit, factor = 1, label, onChange }: NumberInputProps): JSX.Element {
  const shown = Number.isFinite(value) ? Number((value * factor).toFixed(4)) : 0;
  return (
    <span className="relative block min-w-0 flex-1">
      <input
        id={id}
        type="number"
        aria-label={label}
        className={`numeric-input timecode h-control-dense pl-1.5 text-right ${unit ? 'pr-4' : 'pr-1.5'}`}
        value={shown}
        min={min === undefined ? undefined : min * factor}
        max={max === undefined ? undefined : max * factor}
        step={step}
        onChange={(event) => onChange(Number(event.target.value) / factor)}
      />
      {unit && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-1 flex items-center text-2xs text-slate-400">
          {unit}
        </span>
      )}
    </span>
  );
}

/** One number: its label at the left (drag it), the field at the right. */
export function NumberRow(props: Omit<NumberInputProps, 'id'> & { label: string }): JSX.Element {
  const id = useId();
  const step = props.step ?? 0.01;
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      <ScrubLabel htmlFor={id} value={props.value} step={step / (props.factor ?? 1)} onChange={props.onChange} className="field-label truncate">
        {props.label}
      </ScrubLabel>
      <NumberInput {...props} id={id} label={undefined} />
    </div>
  );
}

/** A pair - Position X and Y - on one row, each axis draggable by its letter. */
export function PairRow({
  label,
  xLabel,
  yLabel,
  x,
  y,
  unit,
  factor = 1,
  step = 1,
  onChange,
}: {
  label: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  unit?: string;
  factor?: number;
  step?: number;
  onChange(axis: 'x' | 'y', value: number): void;
}): JSX.Element {
  const xId = useId();
  const yId = useId();
  const axis = (id: string, name: string, letter: string, value: number, which: 'x' | 'y'): JSX.Element => (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <ScrubLabel htmlFor={id} value={value} step={step / factor} onChange={(next) => onChange(which, next)} className="w-3 text-center text-2xs text-slate-400">
        <span aria-hidden>{letter}</span>
        <span className="sr-only">{name}</span>
      </ScrubLabel>
      <NumberInput id={id} value={value} unit={unit} factor={factor} step={step} onChange={(next) => onChange(which, next)} />
    </span>
  );
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      <span className="field-label truncate">{label}</span>
      <span className="flex min-w-0 gap-2">
        {axis(xId, xLabel, 'X', x, 'x')}
        {axis(yId, yLabel, 'Y', y, 'y')}
      </span>
    </div>
  );
}

/** A slider with its value beside it: a readout, or a field when it can be typed. */
export function SliderRow({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  format = plain,
  typed,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?(value: number): string;
  /** A field instead of a readout, in these display units. */
  typed?: { factor?: number; unit?: string; step?: number };
  onChange(value: number): void;
}): JSX.Element {
  const id = useId();
  // Fills from the left only for a quantity that starts at zero; a pan or a
  // boost/cut is centred, and a fill from the left would say the wrong thing.
  const fill = min >= 0 ? { '--fill': `${((value - min) / (max - min || 1)) * 100}%` } : undefined;
  return (
    <div className="grid grid-cols-[76px_1fr_64px] items-center gap-2">
      <ScrubLabel htmlFor={id} value={value} step={step} onChange={(next) => onChange(Math.min(max, Math.max(min, next)))} className="field-label truncate">
        {label}
      </ScrubLabel>
      <input
        id={id}
        type="range"
        className="min-w-0"
        style={fill as React.CSSProperties | undefined}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {typed ? (
        <NumberInput
          id={`${id}-value`}
          label={label}
          value={value}
          min={min}
          max={max}
          step={typed.step ?? step}
          factor={typed.factor}
          unit={typed.unit}
          onChange={(next) => onChange(Math.min(max, Math.max(min, next)))}
        />
      ) : (
        <span className="timecode truncate text-right text-2xs text-slate-300">{format(value)}</span>
      )}
    </div>
  );
}

export function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): JSX.Element {
  return (
    <label className="grid grid-cols-[76px_1fr] items-center gap-2 text-xs text-slate-300">
      <span className="field-label truncate">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

/* Sections ---------------------------------------------------------------- */

export interface SectionProps {
  id: string;
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** On/off switch in the header, as Resolve has on each group. */
  enabled?: boolean;
  onEnabledChange?(enabled: boolean): void;
  onReset?(): void;
  onRemove?(): void;
  right?: ReactNode;
  children: ReactNode;
}

/**
 * A group of settings with a header: fold it, switch it on or off, put it
 * back to its defaults. The body stays in the page when folded (hidden, with
 * data-state) so its opening can be animated.
 */
export function Section({ id, title, open, onOpenChange, enabled, onEnabledChange, onReset, onRemove, right, children }: SectionProps): JSX.Element {
  const t = useT();
  const bodyId = `inspector-section-${id}`;
  return (
    <section data-section={id} data-state={open ? 'open' : 'closed'} data-flip-key={id} className="border-b border-panel-800">
      <div className="flex h-9 items-center gap-1 pl-1.5 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-control py-1 text-left hover:text-white"
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRight size={13} className={`shrink-0 text-slate-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <h3 className={`truncate text-xs font-semibold ${enabled === false ? 'text-slate-400' : 'text-slate-200'}`}>{title}</h3>
        </button>
        {right}
        {onReset && (
          <button type="button" className="tool-button tool-button-dense w-6 px-0" onClick={onReset} {...tip(t('inspector.resetSection', { name: title }))}>
            <RotateCcw size={12} />
          </button>
        )}
        {onRemove && (
          <button type="button" className="tool-button tool-button-dense w-6 px-0 hover:text-red-400" onClick={onRemove} {...tip(t('inspector.removeEffect', { name: title }))}>
            <X size={13} />
          </button>
        )}
        {onEnabledChange && (
          <input
            type="checkbox"
            role="switch"
            className="ml-1"
            aria-label={t('inspector.enableSection', { name: title })}
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
        )}
      </div>
      {/* No display class while folded: `flex` would beat the `hidden`
          attribute (both are one class-level selector, and utilities come
          last), and a folded group stayed open. */}
      <div id={bodyId} hidden={!open} className={`${open ? 'flex' : ''} flex-col gap-2 px-3 pb-3`}>
        {children}
      </div>
    </section>
  );
}
