import { useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';

import { framesToTimecode, parseDuration } from '@shared/utils/timecode';
import {
  MAX_SPEED,
  MIN_SPEED,
  clampSpeed,
  durationForSpeed,
  speedForDuration,
  speedOf,
  sourceFramesUsed,
} from '@renderer/timing/clipSpeed';
import type { Clip } from '@shared/types';

/**
 * Speed and duration, laid out the way Premiere's dialog is.
 *
 * The two numbers are one number seen from two sides - the footage the clip
 * shows divided by the time it takes - so they are chained by default and the
 * chain can be broken, which is what Premiere's "gang" button does. Breaking
 * it means typing a duration that keeps the speed and trims the footage
 * instead.
 *
 * The duration is a timecode, as in Premiere and Resolve, not a count of
 * frames: "150" meant nothing to anyone who had not divided by the frame
 * rate first. It is typed the way those editors read it, from the right
 * ("2:15" is two seconds and fifteen frames), and a bare number still counts
 * frames.
 *
 * "Ripple" is Premiere's "Ripple Edit, Shifting Trailing Clips": without it a
 * clip that grew stops at its neighbour, because clips here never overlap.
 */

export interface SpeedDialogProps {
  clip: Clip;
  fps: number;
  onClose(): void;
  onApply(change: { speed: number; reversed: boolean; ripple: boolean }): void;
}

export function SpeedDialog({ clip, fps, onClose, onApply }: SpeedDialogProps): JSX.Element {
  const t = useT();
  const used = sourceFramesUsed(clip);
  const [percent, setPercent] = useState(Math.round(speedOf(clip) * 1000) / 10);
  const [reversed, setReversed] = useState(clip.reversed === true);
  const [ripple, setRipple] = useState(true);
  const [linked, setLinked] = useState(true);
  /** What is being typed into the duration, while it is being typed. */
  const [durationDraft, setDurationDraft] = useState<string | null>(null);

  const speed = clampSpeed(percent / 100);
  const duration = durationForSpeed(used, speed);
  const draftFrames = durationDraft === null ? duration : parseDuration(durationDraft, fps);
  const draftInvalid = durationDraft !== null && (draftFrames === null || draftFrames <= 0);

  const typeDuration = (text: string): void => {
    setDurationDraft(text);
    const frames = parseDuration(text, fps);
    if (!linked || frames === null || frames <= 0) return;
    setPercent(Math.round(speedForDuration(used, frames) * 1000) / 10);
  };

  return (
    <Dialog
      title={t('speed.title')}
      onClose={onClose}
      testId="speed-dialog"
      widthClass="w-[420px]"
      bodyClassName="space-y-3 p-4"
      footer={
        <>
          <button type="button" className="tool-button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="speed-apply"
            disabled={draftInvalid}
            onClick={() => onApply({ speed, reversed, ripple })}
          >
            {t('speed.apply')}
          </button>
        </>
      }
    >
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="field-label">{t('speed.speed')}</span>
          <span className="relative block">
            <input
              type="number"
              className="numeric-input timecode pr-7"
              data-testid="speed-percent"
              min={MIN_SPEED * 100}
              max={MAX_SPEED * 100}
              step={5}
              value={percent}
              onChange={(event) => {
                setDurationDraft(null);
                setPercent(Number(event.target.value));
              }}
            />
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-slate-400">
              %
            </span>
          </span>
        </label>

        <button
          type="button"
          className="tool-button w-7 px-0"
          aria-pressed={linked}
          aria-label={linked ? t('speed.linked') : t('speed.unlinked')}
          title={linked ? t('speed.linked') : t('speed.unlinked')}
          onClick={() => setLinked((current) => !current)}
        >
          {linked ? <Link2 size={14} /> : <Link2Off size={14} />}
        </button>

        <label className="flex flex-1 flex-col gap-1">
          <span className="field-label">{t('speed.duration')}</span>
          <input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            className={`numeric-input timecode ${draftInvalid ? 'border-red-400 focus:ring-red-400' : ''}`}
            data-testid="speed-duration"
            aria-invalid={draftInvalid}
            aria-describedby="speed-duration-hint"
            value={durationDraft ?? framesToTimecode(duration, fps)}
            onChange={(event) => typeDuration(event.target.value)}
            // Once typing is over, the field shows what the speed makes of it.
            onBlur={() => {
              if (!draftInvalid) setDurationDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !draftInvalid) setDurationDraft(null);
            }}
            disabled={!linked}
          />
        </label>
      </div>

      <p id="speed-duration-hint" className={`text-2xs ${draftInvalid ? 'text-red-300' : 'text-slate-400'}`} role={draftInvalid ? 'alert' : undefined}>
        {draftInvalid
          ? t('speed.invalidDuration')
          : t('speed.hint', { used: framesToTimecode(used, fps), duration: framesToTimecode(duration, fps), frames: duration })}
      </p>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          className="accent-blue-500"
          data-testid="speed-reverse"
          checked={reversed}
          onChange={(event) => setReversed(event.target.checked)}
        />
        {t('speed.reverse')}
      </label>
      {reversed && <p className="pl-6 text-2xs text-amber-300">{t('speed.reverseNote')}</p>}

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          className="accent-blue-500"
          data-testid="speed-ripple"
          checked={ripple}
          onChange={(event) => setRipple(event.target.checked)}
        />
        {t('speed.ripple')}
      </label>
      <p className="pl-6 text-2xs text-slate-400">{t('speed.rippleNote')}</p>
    </Dialog>
  );
}
