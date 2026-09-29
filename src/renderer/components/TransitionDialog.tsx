import { Blend, Clock, Scissors } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The question Final Cut and Resolve ask when a transition goes on a cut
 * without enough footage beyond it - asked here every time, as the editor
 * chose: overlap the clips (and say what that moves), freeze frames (and
 * say what that shows), or leave it. The answer is one undo step.
 */
export function TransitionDialog(): JSX.Element | null {
  const t = useT();
  const pending = useProjectStore((state) => state.ui.pendingTransition);
  const fps = useProjectStore((state) => state.project.fps);
  const resolve = useProjectStore((state) => state.resolvePendingTransition);
  if (!pending) return null;

  const frames = (count: number): string => t('transition.frames', { frames: count, seconds: (count / fps).toFixed(2) });

  return (
    <Dialog
      title={t('transition.askTitle')}
      icon={Blend}
      role="alertdialog"
      onClose={() => resolve('cancel')}
      testId="transition-dialog"
      widthClass="w-[520px]"
      footer={
        <button type="button" data-testid="transition-cancel" className="tool-button h-control border border-panel-600" onClick={() => resolve('cancel')}>
          {t('dialog.cancel')}
        </button>
      }
    >
      <p className="text-xs leading-relaxed text-slate-300">{t('transition.askIntro')}</p>
      <ul className="mt-2 space-y-1">
        {pending.short.map((cut, index) => (
          <li key={index} className="rounded-control bg-panel-950 px-2 py-1.5 text-2xs leading-relaxed text-slate-200">
            {t('transition.askCut', { from: cut.fromName, to: cut.toName, tail: frames(cut.shortTail), head: frames(cut.shortHead) })}
          </li>
        ))}
      </ul>

      <div className="mt-4 grid gap-3">
        <section className="rounded border border-panel-700 bg-panel-900 p-3">
          <button type="button" data-testid="transition-overlap" data-autofocus className="button-primary" onClick={() => resolve('overlap')}>
            <Scissors size={13} />
            {t('transition.overlap')}
          </button>
          <p className="mt-2 text-2xs leading-relaxed text-slate-300">{t('transition.overlapHint', { frames: frames(pending.overlapFrames) })}</p>
          {pending.leftBehind.length > 0 && (
            <p role="note" data-testid="transition-left-behind" className="mt-1.5 text-2xs leading-relaxed text-amber-200">
              {t('transition.leftBehind', { names: pending.leftBehind.join(', '), frames: frames(pending.overlapFrames) })}
            </p>
          )}
        </section>
        <section className="rounded border border-panel-700 bg-panel-900 p-3">
          <button type="button" data-testid="transition-freeze" className="tool-button h-control border border-panel-600" onClick={() => resolve('freeze')}>
            <Clock size={13} />
            {t('transition.freeze')}
          </button>
          <p className="mt-2 text-2xs leading-relaxed text-slate-300">{t('transition.freezeHint')}</p>
        </section>
      </div>
    </Dialog>
  );
}
