import { useState } from 'react';
import { Link2, Link2Off, X } from 'lucide-react';

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

  const speed = clampSpeed(percent / 100);
  const duration = durationForSpeed(used, speed);

  const applyDuration = (frames: number): void => {
    if (!linked || frames <= 0) return;
    setPercent(Math.round(speedForDuration(used, frames) * 1000) / 10);
  };

  return (
    <div className="scf-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-testid="speed-dialog" className="scf-dialog panel w-[380px] shadow-2xl shadow-black/60">
        <header className="panel-header justify-between">
          <span>Speed / Duration</span>
          <button type="button" className="tool-button" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>

        <div className="space-y-3 p-4">
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
                <span className="text-2xs text-slate-500">%</span>
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

          <p className="text-2xs text-slate-500">
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
          <p className="pl-6 text-2xs text-slate-500">
            Off, a clip that grew stops where its neighbour begins.
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-panel-700 px-4 py-3">
          <button type="button" className="tool-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tool-button tool-button-active"
            data-testid="speed-apply"
            onClick={() => onApply({ speed, reversed, ripple })}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
