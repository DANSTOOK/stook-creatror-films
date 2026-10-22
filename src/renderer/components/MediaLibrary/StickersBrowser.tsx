import { useEffect, useId, useRef, useState } from 'react';
import type { MessageKey } from '@shared/i18n';
import { useLanguageStore, useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { STICKERS, STICKER_CATEGORIES, type Sticker } from '@renderer/stickers/catalog';
import { addSticker, drawSticker } from '@renderer/stickers/addSticker';

/**
 * The Stickers tab of the library: every sticker as it will look, in three
 * groups, and one click (or Enter) puts it over the picture at the playhead,
 * on a track of its own, popping on (stickers/addSticker).
 */

const GROUP_LABEL: Record<(typeof STICKER_CATEGORIES)[number], MessageKey> = {
  shapes: 'sticker.groupShapes',
  icons: 'sticker.groupIcons',
  words: 'sticker.groupWords',
};

function StickerTile({ sticker, hintId, busy, onAdd }: { sticker: Sticker; hintId: string; busy: boolean; onAdd(): void }): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Drawn at twice its size on screen, so it is sharp on a high-density display.
    drawSticker(canvas, sticker, 192);
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
        <span className="mt-1 line-clamp-2 block px-0.5 text-xs leading-snug text-slate-200">{t(sticker.label)}</span>
      </button>
    </li>
  );
}

export function StickersBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
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
  return (
    <div data-testid="library-stickers" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
        {t('sticker.hint')}
      </p>
      {STICKER_CATEGORIES.map((category) => (
        <section key={category} className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(GROUP_LABEL[category])}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-x-2 gap-y-2.5">
            {STICKERS.filter((sticker) => sticker.category === category).map((sticker) => (
              <StickerTile key={sticker.id} sticker={sticker} hintId={hintId} busy={busy} onAdd={() => void add(sticker)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
