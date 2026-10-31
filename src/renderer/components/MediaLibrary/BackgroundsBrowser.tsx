import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { MessageKey } from '@shared/i18n';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { BACKGROUNDS, BACKGROUND_GROUPS, type Background, type BackgroundGroup } from '@renderer/backgrounds/catalog';
import { addBackground, drawBackground } from '@renderer/backgrounds/addBackground';

/**
 * The Backgrounds tab of the library: every background as it will look, in its
 * group, and one click puts it behind the footage at the playhead, on a track
 * of its own at the bottom (backgrounds/addBackground).
 *
 * Each tile is drawn in the project's own shape rather than a square, because
 * these fill the frame: a vertical project should show vertical tiles, or the
 * tile is a lie about what the click will do.
 */

const GROUP_LABEL: Record<BackgroundGroup, MessageKey> = {
  gradients: 'background.groupGradients',
  scenes: 'background.groupScenes',
  patterns: 'background.groupPatterns',
  textures: 'background.groupTextures',
};

/** Lower case and without accents: "degradado" finds "Degradado". */
const folded = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function BackgroundTile({
  background,
  aspect,
  hintId,
  busy,
  onAdd,
}: {
  background: Background;
  aspect: number;
  hintId: string;
  busy: boolean;
  onAdd: () => void;
}): JSX.Element {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Drawn larger than it is shown, so it is sharp on a high-density display,
    // and in the project's shape so the tile matches what lands on the timeline.
    const width = 240;
    drawBackground(canvas, background, width, Math.max(1, Math.round(width / aspect)));
  }, [background, aspect]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={`library-background-${background.id}`}
        aria-describedby={hintId}
        disabled={busy}
        className="media-tile press group w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover"
        onClick={onAdd}
      >
        <span className="block overflow-hidden rounded-control bg-panel-950 ring-1 ring-transparent transition-transform group-hover:ring-panel-600">
          <canvas ref={canvasRef} aria-hidden className="block h-auto w-full transition-transform duration-200 group-hover:scale-105" />
        </span>
        <span className="mt-1 line-clamp-2 block px-0.5 text-2xs leading-tight text-slate-300">{t(background.label)}</span>
      </button>
    </li>
  );
}

export function BackgroundsBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<BackgroundGroup | 'all'>('all');
  const [query, setQuery] = useState('');
  // The project's shape, which the tiles take: a vertical edit shows vertical tiles.
  const aspect = useProjectStore((state) => state.project.width / state.project.height);

  const add = async (background: Background): Promise<void> => {
    if (!hasNativeBridge()) return;
    setBusy(true);
    try {
      const clipId = await addBackground(background.id);
      if (clipId) notify(t('background.added', { name: t(background.label) }), 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const wanted = folded(query.trim());
    return BACKGROUND_GROUPS.filter((id) => group === 'all' || id === group)
      .map((id) => ({
        group: id,
        backgrounds: BACKGROUNDS.filter((background) => background.group === id && (!wanted || folded(t(background.label)).includes(wanted))),
      }))
      .filter((entry) => entry.backgrounds.length > 0);
  }, [group, query, t]);

  return (
    <div data-testid="library-backgrounds" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
        {t('background.hint')}
      </p>
      <label className="mb-2 flex items-center gap-1.5 rounded-control border border-panel-700 bg-panel-950 px-2 focus-within:border-accent/70">
        <Search size={13} aria-hidden className="shrink-0 text-slate-400" />
        <input
          type="search"
          data-testid="background-search"
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
          placeholder={t('background.search')}
          aria-label={t('background.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div data-testid="background-groups" className="-mx-2 mb-3 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]" role="group" aria-label={t('library.backgrounds')}>
        {(['all', ...BACKGROUND_GROUPS] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`background-filter-${id}`}
            aria-pressed={group === id}
            className={`tool-button tool-button-dense h-6 shrink-0 rounded-full px-2.5 text-2xs ${group === id ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
            onClick={() => setGroup(id)}
          >
            {t(id === 'all' ? 'background.groupAll' : GROUP_LABEL[id])}
          </button>
        ))}
      </div>
      {shown.map(({ group: id, backgrounds }) => (
        <section key={id} className="mb-3" data-testid={`background-group-${id}`}>
          <h3 className="section-title mb-1.5 px-0.5">{t(GROUP_LABEL[id])}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-1.5 gap-y-2">
            {backgrounds.map((background) => (
              <BackgroundTile key={background.id} background={background} aspect={aspect} hintId={hintId} busy={busy} onAdd={() => void add(background)} />
            ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 && (
        <p data-testid="background-no-match" className="px-1 py-6 text-center text-xs text-slate-400">
          {t('background.noMatch')}
        </p>
      )}
    </div>
  );
}
