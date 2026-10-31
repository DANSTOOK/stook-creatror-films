import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { MessageKey } from '@shared/i18n';
import { useLanguageStore, useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { STICKERS, STICKER_CATEGORIES, type Sticker, type StickerCategory } from '@renderer/stickers/catalog';
import { addSticker, paintSticker } from '@renderer/stickers/addSticker';

/**
 * The Stickers tab of the library: every sticker as it will look, in its
 * group, and one click (or Enter) puts it over the picture at the playhead,
 * on a track of its own, popping on (stickers/addSticker).
 *
 * With sixty-odd of them, as CapCut's panel has it: a row of groups to show
 * one at a time, and a search by name above them.
 */

const GROUP_LABEL: Record<StickerCategory, MessageKey> = {
  reactions: 'sticker.groupReactions',
  shapes: 'sticker.groupShapes',
  icons: 'sticker.groupIcons',
  social: 'sticker.groupSocial',
  party: 'sticker.groupParty',
  nature: 'sticker.groupNature',
  pointers: 'sticker.groupPointers',
  words: 'sticker.groupWords',
  emoji: 'sticker.groupEmoji',
  food: 'sticker.groupFood',
  travel: 'sticker.groupTravel',
};

/** Lower case and without accents: "corazon" finds "Corazón". */
const folded = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function StickerTile({ sticker, hintId, busy, onAdd }: { sticker: Sticker; hintId: string; busy: boolean; onAdd(): void }): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Drawn at twice its size on screen, so it is sharp on a high-density display.
    void paintSticker(canvas, sticker, 192);
  }, [sticker, language]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={`library-sticker-${sticker.id}`}
        aria-describedby={hintId}
        disabled={busy}
        className="media-tile press group w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover"
        onClick={onAdd}
      >
        <span className="flex aspect-square items-center justify-center rounded-control bg-panel-950 ring-1 ring-transparent transition-transform group-hover:ring-panel-600">
          <canvas ref={canvasRef} aria-hidden className="h-3/4 w-3/4 transition-transform duration-200 group-hover:scale-110" />
        </span>
        <span className="mt-1 line-clamp-2 block px-0.5 text-2xs leading-tight text-slate-300">{t(sticker.label)}</span>
      </button>
    </li>
  );
}

export function StickersBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<StickerCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const add = async (sticker: Sticker): Promise<void> => {
    if (!hasNativeBridge()) return;
    setBusy(true);
    try {
      const clipId = await addSticker(sticker.id);
      if (clipId) notify(t('sticker.added', { name: t(sticker.label) }), 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  // The groups shown, each with the stickers in it that match the search.
  const shown = useMemo(() => {
    const wanted = folded(query.trim());
    return STICKER_CATEGORIES.filter((category) => group === 'all' || category === group)
      .map((category) => ({
        category,
        stickers: STICKERS.filter((sticker) => sticker.category === category && (!wanted || folded(t(sticker.label)).includes(wanted))),
      }))
      .filter((entry) => entry.stickers.length > 0);
  }, [group, query, t]);
  // The row of groups has no scrollbar to drag: the wheel over it turns it sideways.
  const groupsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = groupsRef.current;
    if (!row) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || row.scrollWidth <= row.clientWidth) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div data-testid="library-stickers" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
        {t('sticker.hint')}
      </p>
      <label className="mb-2 flex items-center gap-1.5 rounded-control border border-panel-700 bg-panel-950 px-2 focus-within:border-accent/70">
        <Search size={13} aria-hidden className="shrink-0 text-slate-400" />
        <input
          type="search"
          data-testid="sticker-search"
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
          placeholder={t('sticker.search')}
          aria-label={t('sticker.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {/* One row that scrolls sideways, as CapCut's sticker tabs: the stickers keep the panel's height. */}
      <div ref={groupsRef} data-testid="sticker-groups" className="-mx-2 mb-3 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]" role="group" aria-label={t('library.stickers')}>
        {(['all', ...STICKER_CATEGORIES] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`sticker-filter-${id}`}
            aria-pressed={group === id}
            className={`tool-button tool-button-dense h-6 shrink-0 rounded-full px-2.5 text-2xs ${group === id ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
            onClick={() => setGroup(id)}
          >
            {t(id === 'all' ? 'sticker.groupAll' : GROUP_LABEL[id])}
          </button>
        ))}
      </div>
      {shown.map(({ category, stickers }) => (
        <section key={category} className="mb-3" data-testid={`sticker-group-${category}`}>
          <h3 className="section-title mb-1.5 px-0.5">{t(GROUP_LABEL[category])}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-x-1.5 gap-y-2">
            {stickers.map((sticker) => (
              <StickerTile key={sticker.id} sticker={sticker} hintId={hintId} busy={busy} onAdd={() => void add(sticker)} />
            ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 && (
        <p data-testid="sticker-no-match" className="px-1 py-6 text-center text-xs text-slate-400">
          {t('sticker.noMatch')}
        </p>
      )}
    </div>
  );
}
