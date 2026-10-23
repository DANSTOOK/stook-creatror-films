import { useState } from 'react';
import { Loader2, Wind } from 'lucide-react';
import type { MediaAsset } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';

/**
 * Reduce noise, in the inspector's Audio tab: off, light, medium or strong.
 * The file's sound is cleaned by ffmpeg (main/media/denoise.ts) and played
 * and exported in its place - every clip of the file, as its sound is one -
 * and the original comes back when it is turned off. Made once, kept.
 */

type Choice = 'off' | 'light' | 'medium' | 'strong';
const CHOICES: Choice[] = ['off', 'light', 'medium', 'strong'];
const LABEL: Record<Choice, 'denoise.off' | 'denoise.light' | 'denoise.medium' | 'denoise.strong'> = {
  off: 'denoise.off',
  light: 'denoise.light',
  medium: 'denoise.medium',
  strong: 'denoise.strong',
};

export function DenoiseRow({ asset }: { asset: MediaAsset }): JSX.Element {
  const t = useT();
  const [working, setWorking] = useState<Choice | null>(null);
  const current: Choice = asset.denoise ?? 'off';

  const choose = async (choice: Choice): Promise<void> => {
    if (choice === current || working || !asset.sourcePath) return;
    setWorking(choice);
    try {
      const audioUri =
        choice === 'off' ? await window.filmora.extractAudio(asset.sourcePath) : await window.filmora.denoiseAudio(asset.sourcePath, choice);
      if (!audioUri) throw new Error(t('denoise.noSound'));
      useProjectStore.getState().setAssetDenoise(asset.id, choice === 'off' ? null : choice, audioUri);
      if (choice !== 'off') notify(t('denoise.done', { name: asset.name }), 'success');
    } catch (error) {
      notify(t('denoise.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="mx-3 mb-2 space-y-1.5 rounded-lg border border-panel-700 bg-panel-900/60 p-2.5" data-testid="inspector-denoise">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-100">
        <Wind size={13} className="text-accent-hover" aria-hidden />
        {t('denoise.title')}
        {working && <Loader2 size={12} className="ml-auto animate-spin text-slate-400" aria-hidden />}
      </div>
      <div role="radiogroup" aria-label={t('denoise.title')} className="grid grid-cols-4 gap-0.5 rounded-control bg-panel-950 p-0.5">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={current === choice}
            data-testid={`inspector-denoise-${choice}`}
            disabled={working !== null}
            className={`rounded-[4px] py-1 text-2xs ${current === choice ? 'bg-panel-700 font-medium text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
            onClick={() => void choose(choice)}
          >
            {t(LABEL[choice])}
          </button>
        ))}
      </div>
      <p className="text-2xs leading-relaxed text-slate-400">{working ? t('denoise.working') : t('denoise.hint')}</p>
    </div>
  );
}
