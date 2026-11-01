import { useEffect, useRef, useState } from 'react';
import { Loader2, Palette } from 'lucide-react';
import type { Clip, ClipDrawn } from '@shared/types';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { previewTint, redrawClip } from '@renderer/backgrounds/redraw';

/**
 * The colour of a background or a frame this app drew, in the inspector.
 *
 * Both arrive as a flat PNG, so until now the only way to change the colour of
 * one was to delete it and add another - and that loses where it was put, how
 * long it was made and anything else done to it. The clip remembers what it was
 * drawn from (`Clip.drawn`), so this draws it again and swaps the picture under
 * the clip, which keeps all of that.
 *
 * The swatches are drawn the same way the real thing is, so what is shown is
 * what will arrive rather than a coloured square standing in for it.
 */

/** The colours offered, and the strength each swatch shows. */
const COLOURS = ['#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#4ade80', '#f8fafc', '#0f172a'] as const;

function Swatch({
  drawn,
  colour,
  strength,
  chosen,
  busy,
  onPick,
}: {
  drawn: ClipDrawn;
  colour: string | null;
  strength: number;
  chosen: boolean;
  busy: boolean;
  onPick(): void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) previewTint(canvas, drawn, colour ? { color: colour, strength } : undefined);
  }, [drawn, colour, strength]);
  return (
    <button
      type="button"
      data-testid={`clip-fx-drawn-${colour ? colour.replace('#', '') : 'none'}`}
      aria-pressed={chosen}
      disabled={busy}
      className={`press block overflow-hidden rounded-control border ${chosen ? 'border-accent ring-1 ring-accent' : 'border-panel-700'}`}
      onClick={onPick}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-auto w-full" />
    </button>
  );
}

export function DrawnCard({ clip }: { clip: Clip }): JSX.Element | null {
  const t = useT();
  const drawn = clip.drawn;
  const [strength, setStrength] = useState(drawn?.tint?.strength ?? 0.45);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStrength(clip.drawn?.tint?.strength ?? 0.45);
  }, [clip.id, clip.drawn?.tint?.strength]);

  if (!drawn) return null;
  const native = hasNativeBridge();
  const current = drawn.tint?.color ?? null;

  const pick = async (colour: string | null): Promise<void> => {
    if (!native) return;
    setBusy(true);
    try {
      const done = await redrawClip(clip.id, colour ? { color: colour, strength } : undefined);
      if (!done) notify(t('drawn.failed'), 'error');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="clip-fx-drawn" className="rounded-panel border border-panel-700 bg-panel-900/60 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        {busy ? <Loader2 size={13} className="animate-spin text-slate-400" /> : <Palette size={13} aria-hidden className="shrink-0 text-slate-400" />}
        <h4 className="text-xs font-medium text-slate-200">{t('drawn.title')}</h4>
      </div>
      <p className="mb-2 text-2xs leading-relaxed text-slate-400">{t('drawn.hint')}</p>

      <label className="mb-2 flex items-center gap-2 text-2xs text-slate-300">
        <span className="shrink-0">{t('drawn.strength')}</span>
        <input
          type="range"
          data-testid="clip-fx-drawn-strength"
          min={0.1}
          max={1}
          step={0.05}
          value={strength}
          disabled={busy}
          aria-label={t('drawn.strength')}
          className="min-w-0 flex-1"
          onChange={(event) => setStrength(Number(event.target.value))}
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-slate-400">{Math.round(strength * 100)} %</span>
      </label>

      <div role="group" aria-label={t('drawn.title')} className="grid grid-cols-4 gap-1">
        <Swatch drawn={drawn} colour={null} strength={strength} chosen={current === null} busy={busy} onPick={() => void pick(null)} />
        {COLOURS.map((colour) => (
          <Swatch
            key={colour}
            drawn={drawn}
            colour={colour}
            strength={strength}
            chosen={current === colour}
            busy={busy}
            onPick={() => void pick(colour)}
          />
        ))}
      </div>
    </div>
  );
}
