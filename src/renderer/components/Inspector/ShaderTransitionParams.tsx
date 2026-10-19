import { useId } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Transition, TransitionParamValue } from '@shared/types';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { normalizeParamValue, resolvedShaderParams, shaderTransition, type ShaderParam } from '@renderer/fx/transitions/catalog';
import { PairRow, SliderRow, SwitchRow } from './rows';

/**
 * A shader transition's own settings, in the transition's inspector: each
 * the uniform its author exposed, with the range the catalog gives it. Only
 * the ones changed from their defaults are stored (see normalizeShaderParams).
 */

const toHex = (rgb: readonly number[]): string =>
  `#${rgb
    .slice(0, 3)
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;

const fromHex = (hex: string, alpha: number | undefined): number[] => {
  const value = Number.parseInt(hex.slice(1), 16);
  const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
  return alpha === undefined ? rgb : [...rgb, alpha];
};

function ColorRow({ label, value, onChange }: { label: string; value: readonly number[]; onChange(value: number[]): void }): JSX.Element {
  const id = useId();
  const hex = toHex(value);
  return (
    <label htmlFor={id} className="grid grid-cols-[76px_1fr] items-center gap-2">
      <span className="field-label truncate">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          id={id}
          type="color"
          className="h-control-dense w-10 cursor-pointer rounded-control border border-panel-600 bg-panel-950 p-0.5"
          value={hex}
          onChange={(event) => onChange(fromHex(event.target.value, value.length > 3 ? value[3] : undefined))}
        />
        <span className="timecode text-2xs text-slate-300">{hex.toUpperCase()}</span>
      </span>
    </label>
  );
}

export function ShaderTransitionParams({
  transition,
  onChange,
}: {
  transition: Transition;
  onChange(patch: Partial<Transition>, control?: string): void;
}): JSX.Element | null {
  const t = useT();
  const entry = shaderTransition(transition.shader);
  if (!entry) return null;
  const shown = resolvedShaderParams(entry, transition.params).filter(([param]) => param.label);
  if (shown.length === 0) return null;

  const set = (param: ShaderParam, value: TransitionParamValue): void => {
    const next = { ...(transition.params ?? {}), [param.name]: normalizeParamValue(param, value) };
    onChange({ params: next }, `param:${param.name}`);
  };

  return (
    <div data-testid="transition-params" className="flex flex-col gap-2 border-t border-panel-700 pt-2">
      <div className="flex items-center justify-between">
        <span className="section-title">{t('fx.settings')}</span>
        <button
          type="button"
          data-testid="transition-params-reset"
          className="tool-button tool-button-dense w-6 px-0"
          onClick={() => onChange({ params: undefined })}
          {...tip(t('fx.resetSettings'))}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {shown.map(([param, value]) => {
        const label = t(param.label!);
        switch (param.type) {
          case 'bool':
            return <SwitchRow key={param.name} label={label} checked={value === true} onChange={(checked) => set(param, checked)} />;
          case 'float':
          case 'int':
            return (
              <SliderRow
                key={param.name}
                label={label}
                value={value as number}
                min={param.min}
                max={param.max}
                step={param.step ?? ((param.max ?? 1) - (param.min ?? 0)) / 100}
                format={(shownValue) => (param.type === 'int' || param.step === 1 ? String(Math.round(shownValue)) : shownValue.toFixed(2))}
                onChange={(next) => set(param, next)}
              />
            );
          case 'vec2':
          case 'ivec2': {
            const [x, y] = value as number[];
            return (
              <PairRow
                key={param.name}
                label={label}
                xLabel={`${label} X`}
                yLabel={`${label} Y`}
                x={x}
                y={y}
                step={param.type === 'ivec2' ? 1 : 0.05}
                onChange={(axis, next) => set(param, axis === 'x' ? [next, y] : [x, next])}
              />
            );
          }
          case 'color3':
          case 'color4':
            return <ColorRow key={param.name} label={label} value={value as number[]} onChange={(next) => set(param, next)} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
