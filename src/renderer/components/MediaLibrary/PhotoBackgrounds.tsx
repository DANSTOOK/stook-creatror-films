import { useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { needsCredit, photoDataUrl, searchPhotos, type StockPhoto } from '@renderer/backgrounds/photos';
import { addPhotoBackground } from '@renderer/backgrounds/addBackground';
import { notify } from '@renderer/notifications/notifications';

/**
 * Searching Openverse for a real photograph to use as a background.
 *
 * Folded away under the drawn backgrounds on purpose: the drawn ones are
 * instant, work with no network and are beyond question to publish, so they
 * are what a person should meet first. This is for when none of them is the
 * picture they had in mind.
 *
 * Searching happens on Enter or on the button, never as you type: the
 * anonymous allowance is 200 searches a day, and a request per keystroke
 * would spend it in one sentence.
 */

export function PhotoBackgrounds(): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const [photos, setPhotos] = useState<StockPhoto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Thumbnails by id, fetched through main because the page may not. */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const run = useRef(0);

  const go = async (): Promise<void> => {
    const wanted = query.trim();
    if (!wanted || busy) return;
    const ticket = (run.current += 1);
    setBusy(true);
    setProblem(null);
    setThumbs({});
    try {
      const found = await searchPhotos({ query: wanted });
      if (run.current !== ticket) return;
      setPhotos(found.photos);
      if (found.photos.length === 0) setProblem(t('photos.none'));
      // The thumbnails after the grid is up, so the results appear at once
      // and fill in rather than all arriving together.
      for (const photo of found.photos) {
        void photoDataUrl(photo.thumbnail).then((data) => {
          if (data && run.current === ticket) setThumbs((was) => ({ ...was, [photo.id]: data }));
        });
      }
    } catch (error) {
      // Said plainly: the two things that actually go wrong are the daily
      // allowance and having no network, and a user can act on both.
      setProblem((error as Error)?.message === 'rate' ? t('photos.rate') : t('photos.failed'));
      setPhotos([]);
    } finally {
      if (run.current === ticket) setBusy(false);
    }
  };

  const use = async (photo: StockPhoto): Promise<void> => {
    setAdding(photo.id);
    try {
      const clipId = await addPhotoBackground(photo);
      if (!clipId) notify(t('photos.failed'), 'error');
      else if (needsCredit(photo.licence)) notify(t('photos.credited', { creator: photo.creator }), 'info');
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="photo-backgrounds">
      <p className="text-[10px] leading-relaxed text-slate-500">{t('photos.hint')}</p>
      <div className="flex items-center gap-1.5">
        <input
          type="search"
          data-testid="photo-query"
          value={query}
          placeholder={t('photos.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void go();
            }
          }}
          className="min-w-0 flex-1 rounded-control bg-white/5 px-2 py-1.5 text-2xs text-slate-200 ring-1 ring-white/10"
        />
        <button
          type="button"
          data-testid="photo-search"
          disabled={busy || query.trim().length === 0}
          onClick={() => void go()}
          className="flex items-center gap-1 rounded-control bg-white/5 px-2 py-1.5 text-2xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          {t('photos.search')}
        </button>
      </div>

      {problem && (
        <p data-testid="photo-problem" className="text-2xs text-amber-300">
          {problem}
        </p>
      )}

      {photos && photos.length > 0 && (
        <ul data-testid="photo-results" className="grid grid-cols-2 gap-1.5">
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                data-testid={`photo-${photo.id}`}
                disabled={adding !== null}
                onClick={() => void use(photo)}
                title={`${photo.title} — ${photo.creator} (${photo.licence.toUpperCase()})`}
                className="group relative block w-full overflow-hidden rounded-control ring-1 ring-white/10 hover:ring-cyan-400/50 disabled:opacity-50"
              >
                {thumbs[photo.id] ? (
                  <img src={thumbs[photo.id]} alt={photo.title} className="block aspect-video w-full object-cover" />
                ) : (
                  <span className="block aspect-video w-full animate-pulse bg-white/5" />
                )}
                {adding === photo.id && (
                  <span className="absolute inset-0 grid place-items-center bg-slate-950/60">
                    <Loader2 size={16} className="animate-spin text-cyan-200" />
                  </span>
                )}
                {/* Who took it and under what, on the picture itself: a credit
                    nobody can see is no credit. */}
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-slate-950/90 to-transparent px-1 pb-0.5 pt-2 text-left text-[9px] text-slate-300">
                  {photo.creator} · {photo.licence.toUpperCase()}
                  {photo.width > 0 ? ` · ${photo.width}px` : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
