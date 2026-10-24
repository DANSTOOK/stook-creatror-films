import { useEffect, useId, useState } from 'react';
import type { Clip, SpeedRampPreset } from '@shared/types';
import { framesToTimecode, parseDuration } from '@shared/utils/timecode';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { MAX_SPEED, MIN_SPEED, clampSpeed, durationForSpeed, sourceFramesUsed, speedForDuration, speedOf } from '@renderer/timing/clipSpeed';
import { RAMPS, RAMP_LABEL, RampShape } from '@renderer/components/Timeline/SpeedDialog';
import { NumberInput, Section, SwitchRow, type SectionProps } from './rows';

/**
 * The Speed tab, as CapCut's inspector has one: the speed of the selected
 * clip on a slider, its duration, a ramp, and playing it backwards - each
 * applied as it is moved, one undo step for a whole drag (setClipSpeed merges
 * them). The Speed dialog (Ctrl+R, the clip's menu) is still there for
 * typing a speed and a duration apart.
 *
 * The slider is logarithmic, 0.1× at the left, 1× in the middle and 10× at
 * the right: a half-speed and a double-speed clip are the same distance from
 * normal, as the ear and the eye take them. Near 1× it catches on 1×.
 */

/** One arrow key's move along the slider, in thousandths: about 2% of speed, which is out of the catch round 1×. */
const STEP = 5;

const SPAN = Math.log(MAX_SPEED / MIN_SPEED);
const positionOf = (speed: number): number => Math.round((Math.log(speed / MIN_SPEED) / SPAN) * 1000);
const speedAt = (position: number): number => {
  const speed = MIN_SPEED * Math.exp((position / 1000) * SPAN);
  // Within 1.5% of normal speed counts as normal speed - less than one key's step (STEP), so the arrow keys still leave it.
  return Math.abs(speed - 1) < 0.015 ? 1 : clampSpeed(Math.round(speed * 100) / 100);
};

export interface SpeedTabProps {
  clip: Clip;
  fps: number;
  sectionProps(id: string): Pick<SectionProps, 'id' | 'open' | 'onOpenChange'>;
}

export function SpeedTab({ clip, fps, sectionProps }: SpeedTabProps): JSX.Element {
  const t = useT();
  const id = useId();
  const setClipSpeed = useProjectStore((state) => state.setClipSpeed);
  /** Whether what follows on the track moves along: a choice about the tab, as in the dialog, on by default. */
  const [ripple, setRipple] = useState(true);
  const speed = speedOf(clip);
  const used = sourceFramesUsed(clip);
  const duration = durationForSpeed(used, speed);
  const ramp = clip.speedRamp ?? null;
  const reversed = clip.reversed === true;

  /** What is being typed into the duration, while it is being typed. */
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [clip.id]);
  const typed = draft === null ? duration : parseDuration(draft, fps);
  const invalid = draft !== null && (typed === null || typed <= 0);

  const apply = (change: Partial<{ speed: number; reversed: boolean; ramp: SpeedRampPreset | null }>): void =>
    setClipSpeed(clip.id, { speed, reversed, ramp, ripple, ...change });
  const commitDuration = (): void => {
    if (draft === null) return;
    if (!invalid && typed !== null) apply({ speed: clampSpeed(speedForDuration(used, typed)) });
    setDraft(null);
  };

  return (
    <div data-testid="inspector-speed">
      <Section {...sectionProps('speedNormal')} title={t('speed.title')}>
        <div className="grid grid-cols-[76px_1fr_64px] items-center gap-2">
          <label htmlFor={`${id}-slider`} className="field-label truncate">
            {t('speed.speed')}
          </label>
          <input
            id={`${id}-slider`}
            type="range"
            data-testid="inspector-speed-slider"
            className="min-w-0"
            min={0}
            max={1000}
            step={STEP}
            value={positionOf(speed)}
            style={{ '--fill': `${positionOf(speed) / 10}%` } as React.CSSProperties}
            onChange={(event) => apply({ speed: speedAt(Number(event.target.value)) })}
          />
          <NumberInput id={`${id}-value`} label={t('speed.speed')} value={speed} min={MIN_SPEED} max={MAX_SPEED} step={0.1} unit="×" onChange={(value) => apply({ speed: clampSpeed(value) })} />
        </div>
        <label className="grid grid-cols-[76px_1fr] items-center gap-2">
          <span className="field-label truncate">{t('speed.duration')}</span>
          <input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            data-testid="inspector-speed-duration"
            className={`numeric-input timecode h-control-dense ${invalid ? 'border-red-400 focus:ring-red-400' : ''}`}
            aria-invalid={invalid}
            value={draft ?? framesToTimecode(duration, fps)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDuration}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitDuration();
              if (event.key === 'Escape') setDraft(null);
            }}
          />
        </label>
        <p className={`text-2xs leading-relaxed ${invalid ? 'text-red-300' : 'text-slate-400'}`} role={invalid ? 'alert' : undefined}>
          {invalid ? t('speed.invalidDuration') : t('speed.hint', { used: framesToTimecode(used, fps), duration: framesToTimecode(duration, fps), frames: duration })}
        </p>
        <SwitchRow label={t('speed.reverse')} checked={reversed} testId="inspector-speed-reverse" onChange={(next) => apply({ reversed: next })} />
        {reversed && <p className="text-2xs text-amber-300">{t('speed.reverseNote')}</p>}
        <SwitchRow label={t('speed.ripple')} checked={ripple} testId="inspector-speed-ripple" onChange={setRipple} />
      </Section>

      {/* A speed ramp: the clip faster here, slower there, along a curve (timing/clipSpeed). */}
      <Section {...sectionProps('speedRamp')} title={t('ramp.title')}>
        <div role="radiogroup" aria-label={t('ramp.title')} className="grid grid-cols-4 gap-1">
          {[null, ...RAMPS].map((option) => {
            const on = ramp === option;
            return (
              <button
                key={option ?? 'none'}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`inspector-ramp-${option ?? 'none'}`}
                className={`press flex flex-col items-center gap-0.5 rounded-md border px-1 pb-1 pt-1.5 text-2xs transition-colors ${
                  on ? 'border-accent/70 bg-accent/15 text-slate-100' : 'border-panel-700 bg-panel-900 text-slate-400 hover:border-panel-600 hover:text-slate-200'
                }`}
                onClick={() => apply({ ramp: option })}
              >
                <RampShape preset={option} />
                {option ? t(RAMP_LABEL[option]) : t('ramp.none')}
              </button>
            );
          })}
        </div>
        <p className="text-2xs leading-relaxed text-slate-400">{ramp ? t('ramp.hint') : t('ramp.noneHint')}</p>
      </Section>
    </div>
  );
}
