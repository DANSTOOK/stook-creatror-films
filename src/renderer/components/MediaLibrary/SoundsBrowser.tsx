import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Music2, Pause, Play, Plus, Search, Zap } from 'lucide-react';
import type { MessageKey } from '@shared/i18n';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { EFFECT_GROUPS, SOUNDS, type EffectGroup, type Sound } from '@renderer/sounds/catalog';
import { soundSeconds } from '@renderer/sounds/synth';
import { addSound, soundPreviewUrl } from '@renderer/sounds/addSound';

/**
 * The Sounds tab of the library: sound effects and music, every one made in
 * the editor and free to use anywhere (sounds/catalog). Play hears it;
 * the row (or +) puts it at the playhead on an audio track of its own.
 *
 * Fifty-odd of them: the effects in their groups, a row to show one group
 * (or the music) at a time, and a search by name, as the stickers have.
 */

type Shelf = EffectGroup | 'music';

const SHELF_LABEL: Record<Shelf, MessageKey> = {
  transitions: 'sound.groupTransitions',
  interface: 'sound.groupInterface',
  cartoon: 'sound.groupCartoon',
  drums: 'sound.groupDrums',
  everyday: 'sound.groupEveryday',
  nature: 'sound.groupNature',
  music: 'sound.groupMusic',
};

const SHELVES: readonly Shelf[] = [...EFFECT_GROUPS, 'music'];

const shelfOf = (sound: Sound): Shelf => (sound.category === 'music' ? 'music' : (sound.group ?? 'interface'));

/** Lower case and without accents: "trombon" finds "Trombón". */
const folded = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const clock = (seconds: number): string => (seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`);

export function SoundsBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [shelf, setShelf] = useState<Shelf | 'all'>('all');
  const [query, setQuery] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const preview = async (sound: Sound): Promise<void> => {
    if (playing === sound.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    setBusy(sound.id);
    try {
      const url = await soundPreviewUrl(sound.id);
      if (!url) return;
      const audio = new Audio(url);
      audio.onended = () => setPlaying(null);
      audioRef.current = audio;
      setPlaying(sound.id);
      await audio.play().catch(() => setPlaying(null));
    } finally {
      setBusy(null);
    }
  };

  const add = async (sound: Sound): Promise<void> => {
    if (!hasNativeBridge()) return;
    setBusy(sound.id);
    try {
      const clipId = await addSound(sound.id);
      if (clipId) notify(t('sound.added', { name: t(sound.label) }), 'success');
    } catch (error) {
      notify(t('sound.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setBusy(null);
    }
  };

  // The shelves shown, each with the sounds on it that match the search.
  const shown = useMemo(() => {
    const wanted = folded(query.trim());
    return SHELVES.filter((id) => shelf === 'all' || id === shelf)
      .map((id) => ({ id, sounds: SOUNDS.filter((sound) => shelfOf(sound) === id && (!wanted || folded(t(sound.label)).includes(wanted))) }))
      .filter((entry) => entry.sounds.length > 0);
  }, [shelf, query, t]);

  // The row of shelves has no scrollbar to drag: the wheel over it turns it sideways.
  const shelvesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = shelvesRef.current;
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
    <div data-testid="library-sounds" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="mb-2 px-1 text-2xs leading-relaxed text-slate-400">
        {t('sound.hint')}
      </p>
      <label className="mb-2 flex items-center gap-1.5 rounded-control border border-panel-700 bg-panel-950 px-2 focus-within:border-accent/70">
        <Search size={13} aria-hidden className="shrink-0 text-slate-400" />
        <input
          type="search"
          data-testid="sound-search"
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
          placeholder={t('sound.search')}
          aria-label={t('sound.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div ref={shelvesRef} data-testid="sound-shelves" className="-mx-2 mb-3 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]" role="group" aria-label={t('library.sounds')}>
        {(['all', ...SHELVES] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`sound-filter-${id}`}
            aria-pressed={shelf === id}
            className={`tool-button tool-button-dense h-6 shrink-0 rounded-full px-2.5 text-2xs ${shelf === id ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
            onClick={() => setShelf(id)}
          >
            {t(id === 'all' ? 'sound.groupAll' : SHELF_LABEL[id])}
          </button>
        ))}
      </div>
      {shown.map(({ id, sounds }) => {
        const Icon = id === 'music' ? Music2 : Zap;
        return (
          <section key={id} className="mb-3" data-testid={`sound-group-${id}`}>
            <h3 className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-200">
              <Icon size={12} className="text-accent-hover" aria-hidden />
              {t(SHELF_LABEL[id])}
            </h3>
            <ul className="space-y-0.5">
              {sounds.map((sound) => (
                <li key={sound.id} className="group flex items-center gap-1.5 rounded-control px-1 py-0.5 hover:bg-panel-800">
                  <button
                    type="button"
                    data-testid={`library-sound-play-${sound.id}`}
                    aria-label={t(playing === sound.id ? 'sound.stop' : 'sound.play', { name: t(sound.label) })}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-panel-800 text-slate-300 ring-1 ring-panel-600 hover:text-slate-100"
                    disabled={busy !== null && busy !== sound.id}
                    onClick={() => void preview(sound)}
                  >
                    {busy === sound.id && playing !== sound.id ? <Loader2 size={11} className="animate-spin" /> : playing === sound.id ? <Pause size={11} /> : <Play size={11} className="ml-px" />}
                  </button>
                  <button
                    type="button"
                    data-testid={`library-sound-${sound.id}`}
                    aria-describedby={hintId}
                    disabled={busy !== null}
                    className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                    onClick={() => void add(sound)}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={t(sound.label)}>
                      {t(sound.label)}
                    </span>
                    <span className="shrink-0 text-2xs tabular-nums text-slate-500">{clock(soundSeconds(sound))}</span>
                    <Plus size={12} className="shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {shown.length === 0 && (
        <p data-testid="sound-no-match" className="px-1 py-6 text-center text-xs text-slate-400">
          {t('sound.noMatch')}
        </p>
      )}
    </div>
  );
}
