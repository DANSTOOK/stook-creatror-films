import { useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';

import { framesToTimecode } from '@shared/utils/timecode';
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
  const used = sourceFramesUsed(clip);
  const [percent, setPercent] = useState(Math.round(speedOf(clip) * 1000) / 10);
  const [reversed, setReversed] = useState(clip.reversed === true);
  const [ripple, setRipple] = useState(true);
  const [linked, setLinked] = useState(true);

  const t = useT();
  const speed = clampSpeed(percent / 100);
  const duration = durationForSpeed(used, speed);

  const applyDuration = (frames: number): void => {
    if (!linked || frames <= 0) return;
    setPercent(Math.round(speedForDuration(used, frames) * 1000) / 10);
  };

  return (
    <Dialog
      title={t('speed.title')}
      onClose={onClose}
      testId="speed-dialog"
      widthClass="w-[400px]"
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
            onClick={() => onApply({ speed, reversed, ripple })}
          >
            {t('speed.apply')}
          </button>
        </>
      }
    >
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="field-label">Speed</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className="numeric-input"
                  data-testid="speed-percent"
                  min={MIN_SPEED * 100}
                  max={MAX_SPEED * 100}
                  step={5}
                  value={percent}
                  onChange={(event) => setPercent(Number(event.target.value))}
                />
                <span className="text-2xs text-slate-400">%</span>
              </div>
            </label>

            <button
              type="button"
              className="tool-button mb-1 h-8 px-2"
              title={linked ? 'Speed and duration move together' : 'Speed and duration are separate'}
              onClick={() => setLinked((current) => !current)}
            >
              {linked ? <Link2 size={14} /> : <Link2Off size={14} />}
            </button>

            <label className="flex flex-1 flex-col gap-1">
              <span className="field-label">Duration</span>
              <input
                type="number"
                className="numeric-input"
                data-testid="speed-duration"
                min={1}
                step={1}
                value={duration}
                onChange={(event) => applyDuration(Number(event.target.value))}
                disabled={!linked}
              />
            </label>
          </div>

          <p className="text-2xs text-slate-400">
            {used} frames of footage, playing in {duration} - {framesToTimecode(duration, fps)}.
            Frames are sampled, not blended: at half speed each one is held
            twice.
          </p>

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-blue-500"
              data-testid="speed-reverse"
              checked={reversed}
              onChange={(event) => setReversed(event.target.checked)}
            />
            Play backwards
          </label>
          {reversed && (
            <p className="pl-6 text-2xs text-amber-400/80">
              The picture only - a clip played backwards has no sound yet.
            </p>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-blue-500"
              data-testid="speed-ripple"
              checked={ripple}
              onChange={(event) => setRipple(event.target.checked)}
            />
            Move what follows on this track
          </label>
          <p className="pl-6 text-2xs text-slate-400">
            Off, a clip that grew stops where its neighbour begins.
          </p>
    </Dialog>
  );
}
