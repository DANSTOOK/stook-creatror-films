import { useActivityStore } from '@renderer/activity/activity';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useCaptionJob } from '@renderer/captions/captionJob';
import { useT } from '@renderer/i18n';

/**
 * A thin bar along the top of the editor while something runs in the
 * background - files coming in, sound being analysed, captions being
 * written - as browsers and Premiere show work in progress without a dialog
 * in the way. Captions know how far they are, and the bar fills with them;
 * the rest only know they are going on, and a band travels along it.
 */
export function ActivityBar(): JSX.Element {
  const t = useT();
  const importing = useActivityStore((state) => Object.keys(state.tasks).length > 0);
  const analysing = useMediaStore((state) => state.analysing.length > 0);
  const phase = useCaptionJob((state) => state.phase);
  const fraction = useCaptionJob((state) => state.fraction);
  const captions = phase !== 'idle';
  const busy = importing || analysing || captions;
  const label = captions ? t('activity.captions') : importing ? t('activity.importing') : t('activity.analysing');

  return (
    <div
      data-testid="activity-bar"
      data-busy={busy ? 'true' : 'false'}
      role="progressbar"
      aria-label={label}
      aria-hidden={!busy}
      aria-valuemin={captions ? 0 : undefined}
      aria-valuemax={captions ? 100 : undefined}
      aria-valuenow={captions ? Math.round(fraction * 100) : undefined}
      className="scf-activity pointer-events-none absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden"
    >
      {captions ? (
        <span className="scf-activity-fill block h-full origin-left bg-accent" style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, fraction))})` }} />
      ) : busy && (
        <span className="scf-activity-band absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent-hover to-transparent" />
      )}
    </div>
  );
}
