import { useId } from 'react';
import { ArrowDown, ArrowUp, Diamond } from 'lucide-react';
import type { Clip, ClipEffect } from '@shared/types';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import type { ContextMenuItem } from '@renderer/components/ContextMenu';
import { useProjectStore } from '@renderer/store/useProjectStore';
import {
  EFFECT_CATEGORIES,
  EFFECTS,
  createEffect,
  defaultParams,
  effectCategoryLabel,
  effectDef,
  effectLabel,
  effectValuesAt,
  toggleKeyframe,
  withParam,
  type EffectParamDef,
} from '@renderer/fx/effects/catalog';
import { Section, type SectionProps } from './rows';

/**
 * The clip's effect stack in the Video tab: one section per effect, in the
 * order they run (top first), each with its switch, reset, remove and a way
 * up or down the stack; and its settings, each with a keyframe button.
 *
 * A setting with no keyframes holds still and a change just changes it;
 * the diamond starts animating it with a keyframe at the playhead, after
 * which a change places a keyframe there, as the transform's numbers do.
 * Switches cannot animate.
 */

const display = (param: EffectParamDef, value: number): string => {
  switch (param.format) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'signedPercent':
      return `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
    case 'degrees':
      // Hue is stored as a turn either way (-1..1), the rest in degrees.
      return `${Math.round(param.name === 'hue' && param.max <= 1 ? value * 180 : value)}°`;
    case 'px':
      return `${Number(value.toFixed(1))} px`;
    case 'position':
      return `${Math.round(value * 100)}%`;
    default:
      return Number(value.toFixed(2)).toString();
  }
};

function ParamRow({
  param,
  effect,
  frame,
  onChange,
}: {
  param: EffectParamDef;
  effect: ClipEffect;
  frame: number;
  onChange(next: ClipEffect, merge: boolean): void;
}): JSX.Element {
  const t = useT();
  const id = useId();
  const value = effectValuesAt(effect, frame)[param.name];
  const label = t(param.label);
  if (param.format === 'toggle') {
    return (
      <label className="grid grid-cols-[76px_1fr] items-center gap-2 text-xs text-slate-300">
        <span className="field-label truncate">{label}</span>
        <input type="checkbox" role="switch" checked={value >= 0.5} onChange={(event) => onChange(withParam(effect, param.name, event.target.checked ? 1 : 0, frame), false)} />
      </label>
    );
  }
  const track = effect.keyframes?.[param.name] ?? [];
  const animated = track.length > 0;
  const onKey = track.some((key) => key.frame === Math.round(frame));
  const fill = param.min >= 0 ? { '--fill': `${((value - param.min) / (param.max - param.min || 1)) * 100}%` } : undefined;
  return (
    <div className="grid grid-cols-[76px_1fr_56px_20px] items-center gap-2" data-param={param.name}>
      <label htmlFor={id} className="field-label truncate">
        {label}
      </label>
      <input
        id={id}
        type="range"
        className="min-w-0"
        style={fill as React.CSSProperties | undefined}
        value={value}
        min={param.min}
        max={param.max}
        step={param.step}
        onChange={(event) => onChange(withParam(effect, param.name, Number(event.target.value), frame), true)}
      />
      <span className="timecode truncate text-right text-2xs text-slate-300">{display(param, value)}</span>
      <button
        type="button"
        data-testid={`effect-keyframe-${param.name}`}
        aria-pressed={onKey}
        className="tool-button tool-button-dense w-5 px-0"
        onClick={() => onChange(toggleKeyframe(effect, param.name, frame), false)}
        {...tip(t(!animated ? 'fx.keyframeAdd' : onKey ? 'fx.keyframeRemove' : 'fx.keyframeBetween'))}
      >
        <Diamond size={10} className={onKey ? 'fill-current text-accent-hover' : animated ? 'text-accent-hover' : 'text-slate-500'} />
      </button>
    </div>
  );
}

/** The "Add effect" menu's stack effects, a submenu per category. */
export function effectMenuItems(t: ReturnType<typeof useT>, onAdd: (type: string) => void): ContextMenuItem[] {
  return EFFECT_CATEGORIES.map((category) => ({
    label: t(effectCategoryLabel(category)),
    submenu: EFFECTS.filter((effect) => effect.category === category).map((effect) => ({
      label: t(effectLabel(effect.type)),
      onSelect: () => onAdd(effect.type),
    })),
  }));
}

/** Put a new effect of `type` at the bottom of the clip's stack: it runs last. */
export function addStackEffect(clip: Clip, type: string): string {
  const effect = createEffect(type);
  useProjectStore.getState().updateClip(clip.id, { effects: [...(clip.effects ?? []), effect] });
  return effect.id;
}

export function EffectStack({
  clip,
  frame,
  sectionProps,
}: {
  clip: Clip;
  frame: number;
  sectionProps(id: string): Pick<SectionProps, 'id' | 'open' | 'onOpenChange'>;
}): JSX.Element | null {
  const t = useT();
  const updateClip = useProjectStore((state) => state.updateClip);
  const effects = clip.effects ?? [];
  if (effects.length === 0) return null;

  const replace = (next: ClipEffect[], mergeKey?: string): void => updateClip(clip.id, { effects: next.length > 0 ? next : undefined }, mergeKey);
  const change = (index: number, effect: ClipEffect, merge: boolean): void =>
    replace(effects.map((current, at) => (at === index ? effect : current)), merge ? `effect:${clip.id}:${effect.id}` : undefined);
  const move = (index: number, by: -1 | 1): void => {
    const next = [...effects];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken);
    replace(next);
  };

  return (
    <div data-testid="effect-stack">
      {effects.map((effect, index) => {
        const def = effectDef(effect.type);
        if (!def) return null;
        const title = t(effectLabel(effect.type));
        return (
          <Section
            key={effect.id}
            {...sectionProps(`effect-${effect.id}`)}
            title={title}
            enabled={effect.enabled}
            onEnabledChange={(enabled) => change(index, { ...effect, enabled }, false)}
            onReset={() => {
              const { keyframes: _dropped, ...rest } = effect;
              void _dropped;
              change(index, { ...rest, params: defaultParams(def) }, false);
            }}
            onRemove={() => replace(effects.filter((_, at) => at !== index))}
            right={
              <span className="flex items-center" data-testid={`effect-${effect.type}`}>
                <button type="button" className="tool-button tool-button-dense w-6 px-0" disabled={index === 0} onClick={() => move(index, -1)} {...tip(t('fx.moveUp'))}>
                  <ArrowUp size={12} />
                </button>
                <button
                  type="button"
                  className="tool-button tool-button-dense w-6 px-0"
                  disabled={index === effects.length - 1}
                  onClick={() => move(index, 1)}
                  {...tip(t('fx.moveDown'))}
                >
                  <ArrowDown size={12} />
                </button>
              </span>
            }
          >
            {def.params.map((param) => (
              <ParamRow key={param.name} param={param} effect={effect} frame={frame} onChange={(next, merge) => change(index, next, merge)} />
            ))}
            {def.cost === 'heavy' && <p className="text-2xs leading-relaxed text-amber-300/90">{t('fx.heavy')}</p>}
          </Section>
        );
      })}
      <p className="px-3 py-2 text-2xs leading-relaxed text-slate-400">{t('fx.stackHint')}</p>
    </div>
  );
}
