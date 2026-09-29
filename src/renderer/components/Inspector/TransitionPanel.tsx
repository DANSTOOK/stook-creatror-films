import { useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Clip, Transition, TransitionAlignment, TransitionDirection } from '@shared/types';
import { useT, type MessageKey } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { assetLengthFrames } from '@renderer/media/assetLength';
import { DIP_BLACK, DIP_WHITE, MIN_TRANSITION_FRAMES, headHandle, neededHandles, presetKind, tailHandle } from '@renderer/timing/transitions';
import { Section, SliderRow, SwitchRow } from './rows';

/**
 * The inspector for a transition picked on the timeline: its type, its
 * length, where it sits on the cut and, for a dip, its colour - and, when a
 * clip runs out of footage under it, which one and by how much, in words.
 */

type Choice = 'crossDissolve' | 'dipToBlack' | 'dipToWhite' | 'dipToColor' | 'wipe' | 'slide' | 'push';

const CHOICES: Array<{ id: Choice; label: MessageKey }> = [
  { id: 'crossDissolve', label: 'transition.crossDissolve' },
  { id: 'dipToBlack', label: 'transition.dipToBlack' },
  { id: 'dipToWhite', label: 'transition.dipToWhite' },
  { id: 'dipToColor', label: 'transition.dip' },
  { id: 'wipe', label: 'transition.wipe' },
  { id: 'slide', label: 'transition.slide' },
  { id: 'push', label: 'transition.push' },
];

const DIRECTIONS: Array<{ id: TransitionDirection; label: MessageKey }> = [
  { id: 'left', label: 'transition.directionLeft' },
  { id: 'right', label: 'transition.directionRight' },
  { id: 'up', label: 'transition.directionUp' },
  { id: 'down', label: 'transition.directionDown' },
];

const ALIGNMENTS: Array<{ id: TransitionAlignment; label: MessageKey }> = [
  { id: 'center', label: 'transition.alignCenter' },
  { id: 'start', label: 'transition.alignStart' },
  { id: 'end', label: 'transition.alignEnd' },
];

const choiceOf = (transition: Transition): Choice => {
  if (transition.kind !== 'dip') return transition.kind;
  if (transition.color === DIP_BLACK) return 'dipToBlack';
  if (transition.color === DIP_WHITE) return 'dipToWhite';
  return 'dipToColor';
};

export function TransitionPanel({ transition }: { transition: Transition }): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const updateTransition = useProjectStore((state) => state.updateTransition);
  const removeTransition = useProjectStore((state) => state.removeTransition);
  const typeId = useId();
  const alignId = useId();
  const colourId = useId();
  const directionId = useId();
  const [open, setOpen] = useState(true);

  const from = project.clips[transition.fromClipId];
  const to = project.clips[transition.toClipId];
  const lengthOf = (clip: Clip): number | undefined => {
    const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
    return !asset || asset.kind === 'image' || clip.title ? undefined : assetLengthFrames(asset, project.fps);
  };
  const frames = (count: number): string => t('transition.frames', { frames: count, seconds: (count / project.fps).toFixed(2) });
  const needed = neededHandles(transition.durationFrames, transition.alignment);
  const tail = from ? tailHandle(from, lengthOf(from)) : Infinity;
  const head = to ? headHandle(to, lengthOf(to)) : Infinity;
  const choice = choiceOf(transition);
  const set = (patch: Partial<Transition>, control?: string): void =>
    updateTransition(transition.id, patch, control ? `transition:${transition.id}:${control}` : undefined);
  const longest = Math.max(MIN_TRANSITION_FRAMES, (from?.durationFrames ?? 0) + (to?.durationFrames ?? 0));

  return (
    <div data-testid="transition-panel">
      <p className="px-3 pt-2 text-2xs text-slate-400">{t('transition.between', { from: from?.name ?? '?', to: to?.name ?? '?' })}</p>
      <Section id="transition" title={t('transition.name')} open={open} onOpenChange={setOpen}>
        <label htmlFor={typeId} className="grid grid-cols-[76px_1fr] items-center gap-2">
          <span className="field-label">{t('transition.type')}</span>
          <select
            id={typeId}
            data-testid="transition-type"
            className="numeric-input h-control-dense"
            value={choice}
            onChange={(event) => {
              const next = event.target.value as Choice;
              if (next === 'crossDissolve') set({ kind: 'crossDissolve' });
              else if (next === 'dipToBlack') set({ kind: 'dip', color: DIP_BLACK });
              else if (next === 'dipToWhite') set({ kind: 'dip', color: DIP_WHITE });
              else if (next === 'dipToColor') set({ kind: 'dip', color: transition.color === DIP_BLACK || transition.color === DIP_WHITE ? '#2563eb' : transition.color });
              // A wipe, slide or push starts the way its preset travels.
              else set({ kind: next, direction: presetKind(next).direction });
            }}
          >
            {CHOICES.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>
        {transition.kind === 'dip' && (
          <label htmlFor={colourId} className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="field-label">{t('transition.color')}</span>
            <span className="flex items-center gap-1.5">
              <input
                id={colourId}
                type="color"
                aria-label={t('transition.dipColor')}
                data-testid="transition-color"
                className="h-control-dense w-10 cursor-pointer rounded-control border border-panel-600 bg-panel-950 p-0.5"
                value={transition.color}
                onChange={(event) => set({ color: event.target.value.toLowerCase() }, 'color')}
              />
              <span className="timecode text-2xs text-slate-300">{transition.color.toUpperCase()}</span>
            </span>
          </label>
        )}
        {(transition.kind === 'wipe' || transition.kind === 'slide' || transition.kind === 'push') && (
          <label htmlFor={directionId} className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="field-label">{t('transition.direction')}</span>
            <select
              id={directionId}
              data-testid="transition-direction"
              className="numeric-input h-control-dense"
              value={transition.direction}
              onChange={(event) => set({ direction: event.target.value as TransitionDirection })}
            >
              {DIRECTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>
        )}
        {transition.kind === 'wipe' && (
          <SliderRow
            label={t('transition.softness')}
            value={transition.softness}
            typed={{ factor: 100, unit: '%', step: 1 }}
            onChange={(softness) => set({ softness }, 'softness')}
          />
        )}
        <SliderRow
          label={t('transition.duration')}
          value={transition.durationFrames}
          min={MIN_TRANSITION_FRAMES}
          max={Math.min(longest, Math.round(project.fps * 5))}
          step={1}
          format={(value) => `${(Math.round(value) / project.fps).toFixed(2)} s`}
          onChange={(value) => set({ durationFrames: Math.round(value) }, 'duration')}
        />
        <label htmlFor={alignId} className="grid grid-cols-[76px_1fr] items-center gap-2">
          <span className="field-label">{t('transition.alignment')}</span>
          <select
            id={alignId}
            data-testid="transition-alignment"
            className="numeric-input h-control-dense"
            value={transition.alignment}
            onChange={(event) => set({ alignment: event.target.value as TransitionAlignment })}
          >
            {ALIGNMENTS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>
        {from && tail < needed.tail && (
          <p role="status" data-testid="transition-runs-out-tail" className="rounded-control bg-red-500/10 px-2 py-1.5 text-2xs leading-relaxed text-red-200">
            {t('transition.runsOutTail', { clip: from.name, have: frames(tail), need: frames(needed.tail) })}
          </p>
        )}
        {to && head < needed.head && (
          <p role="status" data-testid="transition-runs-out-head" className="rounded-control bg-red-500/10 px-2 py-1.5 text-2xs leading-relaxed text-red-200">
            {t('transition.runsOutHead', { clip: to.name, have: frames(head), need: frames(needed.head) })}
          </p>
        )}
        {/* The sound goes across the cut with the picture, as Final Cut's does. */}
        <SwitchRow label={t('transition.audio')} checked={transition.audioCrossfade} onChange={(audioCrossfade) => set({ audioCrossfade })} />
        <p className="text-2xs leading-relaxed text-slate-400">{t(transition.audioCrossfade ? 'transition.audioOn' : 'transition.audioOff')}</p>
        <p className="text-2xs leading-relaxed text-slate-400">{t('transition.hint')}</p>
        <button
          type="button"
          data-testid="transition-delete"
          className="tool-button h-control self-start border border-panel-600 hover:text-red-400"
          onClick={() => removeTransition(transition.id)}
        >
          <Trash2 size={13} />
          {t('transition.delete')}
        </button>
      </Section>
    </div>
  );
}
