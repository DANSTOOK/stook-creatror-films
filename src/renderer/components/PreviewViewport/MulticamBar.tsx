import { useEffect } from 'react';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { multicamAt } from '@renderer/edit/multicam';

/**
 * The cameras of the multicam clip under the playhead, under the viewer:
 * click one - or press its number - to cut to it there, as Final Cut's
 * angle viewer and Premiere's multi-camera monitor do. Shown only while the
 * playhead is over a multicam clip.
 */
export function MulticamBar(): JSX.Element | null {
  const t = useT();
  const clip = useProjectStore((state) => multicamAt(state.project, state.project.currentFrame));
  const assets = useProjectStore((state) => state.assets);

  // 1 to 9: cut to that angle at the playhead - typing anywhere else is left alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const state = useProjectStore.getState();
      const under = multicamAt(state.project, state.project.currentFrame);
      const angle = Number(event.key) - 1;
      if (!under?.multicam || angle >= under.multicam.angles.length) return;
      event.preventDefault();
      state.switchAngle(under.id, angle, state.project.currentFrame);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!clip?.multicam) return null;
  const { angles, angle: shown } = clip.multicam;
  return (
    <div
      data-testid="multicam-bar"
      role="toolbar"
      aria-label={t('multicam.angles')}
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-panel-700 bg-panel-800 px-3 py-1.5"
    >
      <span className="mr-1 shrink-0 text-2xs font-semibold uppercase tracking-wide text-slate-400">{t('multicam.angles')}</span>
      {angles.map((angle, index) => {
        const poster = assets.find((asset) => asset.uri === angle.sourceUri)?.thumbnailUri;
        const active = index === shown;
        return (
          <button
            key={`${angle.sourceUri}-${index}`}
            type="button"
            data-testid="multicam-angle"
            aria-pressed={active}
            onClick={() => {
              const state = useProjectStore.getState();
              state.switchAngle(clip.id, index, state.project.currentFrame);
            }}
            className={`group relative flex h-11 w-[72px] shrink-0 items-end overflow-hidden rounded-md bg-black ring-1 transition ${
              active ? 'ring-2 ring-accent' : 'ring-white/10 hover:ring-white/30'
            }`}
            {...tip(t('multicam.angleHint', { name: angle.name }), { shortcut: String(index + 1), named: false })}
          >
            {poster && <img src={poster} alt="" className={`absolute inset-0 h-full w-full object-cover ${active ? '' : 'opacity-70 group-hover:opacity-100'}`} />}
            <span className={`relative m-1 rounded px-1 text-2xs font-semibold tabular-nums ${active ? 'bg-accent text-white' : 'bg-black/70 text-slate-200'}`}>
              {index + 1}
            </span>
          </button>
        );
      })}
    </div>
  );
}
