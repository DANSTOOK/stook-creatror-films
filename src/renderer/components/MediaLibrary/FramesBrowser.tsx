import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { MessageKey } from '@shared/i18n';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { FRAMES, FRAME_GROUPS, type Frame, type FrameGroup } from '@renderer/frames/catalog';
import { addFrame, drawFrame } from '@renderer/frames/addFrame';

/**
 * The Frames tab of the library: every frame as it will look, in its group, and
 * one click lays it over the video at the playhead on a track of its own
 * (frames/addFrame).
 *
 * A frame is mostly transparent, so a tile of one alone would be a few lines on
 * a dark panel. Each tile is drawn over a stand-in picture first - a plain
 * gradient, not a photograph - so what the frame does to a picture is what the
 * tile shows. The tiles are in the project's shape, as the backgrounds' are:
 * a frame is the one thing that must not be stretched, and a square tile of a
 * vertical frame would say nothing about its edges.
 */

const GROUP_LABEL: Record<FrameGroup, MessageKey> = {
  safe: 'frame.groupSafe',
  borders: 'frame.groupBorders',
  vignettes: 'frame.groupVignettes',
};

/** Lower case and without accents: "vineta" finds "Viñeta". */
const folded = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The stand-in a tile draws its frame over: enough picture to read an edge against. */
function standIn(context: CanvasRenderingContext2D, width: number, height: number): void {
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#64748b');
  gradient.addColorStop(0.5, '#94a3b8');
  gradient.addColorStop(1, '#475569');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function FrameTile({
  frame,
  aspect,
  hintId,
  busy,
  onAdd,
}: {
  frame: Frame;
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
    const width = 240;
    const height = Math.max(1, Math.round(width / aspect));
    drawFrame(canvas, frame, width, height);
    // The stand-in goes UNDER what was drawn, which is what the frame leaves clear.
    const context = canvas.getContext('2d');
    if (!context) return;
    context.globalCompositeOperation = 'destination-over';
    standIn(context, width, height);
    context.globalCompositeOperation = 'source-over';
  }, [frame, aspect]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={`library-frame-${frame.id}`}
        aria-describedby={hintId}
        disabled={busy}
        className="media-tile press group w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover"
        onClick={onAdd}
      >
        <span className="block overflow-hidden rounded-control bg-panel-950 ring-1 ring-transparent transition-transform group-hover:ring-panel-600">
          <canvas ref={canvasRef} aria-hidden className="block h-auto w-full transition-transform duration-200 group-hover:scale-105" />
        </span>
        <span className="mt-1 line-clamp-2 block px-0.5 text-2xs leading-tight text-slate-300">{t(frame.label)}</span>
      </button>
    </li>
  );
}

export function FramesBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<FrameGroup | 'all'>('all');
  const [query, setQuery] = useState('');
  const aspect = useProjectStore((state) => state.project.width / state.project.height);

  const add = async (frame: Frame): Promise<void> => {
    if (!hasNativeBridge()) return;
    setBusy(true);
    try {
      const clipId = await addFrame(frame.id);
      if (clipId) notify(t('frame.added', { name: t(frame.label) }), 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const wanted = folded(query.trim());
    return FRAME_GROUPS.filter((id) => group === 'all' || id === group)
      .map((id) => ({
        group: id,
        frames: FRAMES.filter((frame) => frame.group === id && (!wanted || folded(t(frame.label)).includes(wanted))),
      }))
      .filter((entry) => entry.frames.length > 0);
  }, [group, query, t]);

  return (
    <div data-testid="library-frames" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
        {t('frame.hint')}
      </p>
      <label className="mb-2 flex items-center gap-1.5 rounded-control border border-panel-700 bg-panel-950 px-2 focus-within:border-accent/70">
        <Search size={13} aria-hidden className="shrink-0 text-slate-400" />
        <input
          type="search"
          data-testid="frame-search"
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
          placeholder={t('frame.search')}
          aria-label={t('frame.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div data-testid="frame-groups" className="-mx-2 mb-3 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]" role="group" aria-label={t('library.frames')}>
        {(['all', ...FRAME_GROUPS] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`frame-filter-${id}`}
            aria-pressed={group === id}
            className={`tool-button tool-button-dense h-6 shrink-0 rounded-full px-2.5 text-2xs ${group === id ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
            onClick={() => setGroup(id)}
          >
            {t(id === 'all' ? 'frame.groupAll' : GROUP_LABEL[id])}
          </button>
        ))}
      </div>
      {shown.map(({ group: id, frames }) => (
        <section key={id} className="mb-3" data-testid={`frame-group-${id}`}>
          <h3 className="section-title mb-1.5 px-0.5">{t(GROUP_LABEL[id])}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-1.5 gap-y-2">
            {frames.map((frame) => (
              <FrameTile key={frame.id} frame={frame} aspect={aspect} hintId={hintId} busy={busy} onAdd={() => void add(frame)} />
            ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 && (
        <p data-testid="frame-no-match" className="px-1 py-6 text-center text-xs text-slate-400">
          {t('frame.noMatch')}
        </p>
      )}
    </div>
  );
}
