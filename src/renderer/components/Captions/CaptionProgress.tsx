import { Captions, X } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { useCaptionJob } from '@renderer/captions/captionJob';

/**
 * How far along the captions are, while they are being generated.
 *
 * A small card in the corner, not a dialog: transcribing takes from seconds
 * to minutes and the editor stays usable meanwhile, so nothing here takes
 * the keyboard or covers the work. It is a live region, so a screen reader
 * hears the phase change, and Cancel stops the job and deletes its sound.
 */
export function CaptionProgress(): JSX.Element | null {
  const t = useT();
  const phase = useCaptionJob((state) => state.phase);
  const fraction = useCaptionJob((state) => state.fraction);
  const cancel = useCaptionJob((state) => state.cancel);
  if (phase === 'idle') return null;

  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const label = t(phase === 'mixing' ? 'captions.progressMixing' : 'captions.progressTranscribing');

  return (
    <div
      data-testid="captions-progress"
      data-phase={phase}
      className="fixed bottom-3 left-3 z-[60] w-[280px] space-y-2 rounded-menu border border-panel-600 bg-panel-800 p-3 shadow-2xl shadow-black/60"
    >
      <div className="flex items-center gap-2">
        <Captions size={14} className="shrink-0 text-slate-400" aria-hidden />
        <p role="status" className="min-w-0 flex-1 truncate text-xs text-slate-100">
          {label}
        </p>
        <span className="text-2xs tabular-nums text-slate-400" data-testid="captions-progress-percent">
          {percent}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-700" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="scf-progress-bar h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs leading-snug text-slate-400">{t('captions.progressHint')}</p>
        <button type="button" className="tool-button h-control-dense shrink-0 border border-panel-600 px-2 text-2xs" data-testid="captions-cancel" onClick={cancel}>
          <X size={12} aria-hidden />
          {t('dialog.cancel')}
        </button>
      </div>
    </div>
  );
}

export default CaptionProgress;
