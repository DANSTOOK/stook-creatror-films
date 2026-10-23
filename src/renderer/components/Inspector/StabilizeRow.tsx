import { useEffect, useState } from 'react';
import { Loader2, Move3d } from 'lucide-react';
import type { MediaAsset } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';

/**
 * Stabilize, in the inspector's Video tab: off, light, medium or strong.
 * The file is stabilized by ffmpeg's vid.stab (main/media/stabilize.ts) and
 * shown and exported in its place - every clip of the file, as the shake is
 * the file's - while the original stays on disk, untouched, and comes back
 * when it is turned off. Made once, kept; the work shows its progress.
 */

type Choice = 'off' | 'light' | 'medium' | 'strong';
const CHOICES: Choice[] = ['off', 'light', 'medium', 'strong'];

export function StabilizeRow({ asset }: { asset: MediaAsset }): JSX.Element {
  const t = useT();
  const [working, setWorking] = useState<Choice | null>(null);
  const [progress, setProgress] = useState(0);
  const current: Choice = asset.stabilize ?? 'off';

  useEffect(() => {
    if (!working || !window.filmora?.onStabilizeProgress) return undefined;
    return window.filmora.onStabilizeProgress((update) => {
      if (update.path === asset.sourcePath) setProgress(update.fraction);
    });
  }, [working, asset.sourcePath]);

  const choose = async (choice: Choice): Promise<void> => {
    if (choice === current || working || !asset.sourcePath) return;
    setWorking(choice);
    setProgress(0);
    try {
      await window.filmora.stabilizeVideo(asset.sourcePath, choice === 'off' ? null : choice, asset.durationSeconds ?? 0, asset.uri);
      useProjectStore.getState().setAssetStabilize(asset.id, choice === 'off' ? null : choice);
      if (choice !== 'off') notify(t('stabilize.done', { name: asset.name }), 'success');
    } catch (error) {
      notify(t('stabilize.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="mx-2 mb-2 space-y-1.5 rounded-lg border border-panel-700 bg-panel-900/60 p-2.5" data-testid="inspector-stabilize">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-100">
        <Move3d size={13} className="text-accent-hover" aria-hidden />
        {t('stabilize.title')}
        {working && (
          <span className="ml-auto flex items-center gap-1 text-2xs tabular-nums text-slate-400" data-testid="inspector-stabilize-progress">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            {Math.round(progress * 100)} %
          </span>
        )}
      </div>
      <div role="radiogroup" aria-label={t('stabilize.title')} className="grid grid-cols-4 gap-0.5 rounded-control bg-panel-950 p-0.5">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={current === choice}
            data-testid={`inspector-stabilize-${choice}`}
            disabled={working !== null}
            className={`rounded-[4px] py-1 text-2xs ${current === choice ? 'bg-panel-700 font-medium text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
            onClick={() => void choose(choice)}
          >
            {t(`stabilize.${choice}` as 'stabilize.off')}
          </button>
        ))}
      </div>
      {working && (
        <div className="h-1 overflow-hidden rounded-full bg-panel-950" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <p className="text-2xs leading-relaxed text-slate-400">{working ? t('stabilize.working') : t('stabilize.hint')}</p>
    </div>
  );
}
