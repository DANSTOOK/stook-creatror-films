import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Gauge, Loader2, X } from 'lucide-react';

import { proxySummary, wantsProxy } from '@renderer/media/proxyState';
import { useProxies, useProxiesEnabled } from '@renderer/media/useProxies';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useLanguageStore, useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';

/**
 * Proxies, as a small indicator in the media panel's header.
 *
 * It used to be a strip across the top of the panel: two lines of text and a
 * checkbox pushing the bins and clips down, for something set once per
 * project. Now it is a chip - "Proxies 1/4" - that opens the same controls in
 * a popover, the way Final Cut keeps its background tasks behind a toolbar
 * button. It only appears when there is footage heavy enough to need it - a
 * project of 720p clips has nothing to say here, and a control that does
 * nothing is worse than no control. What it says is exactly what is true:
 * how many are ready, what is building, and that the export reads the
 * originals whatever the switch is set to.
 */
export function ProxyBar(): JSX.Element | null {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const assets = useProjectStore((state) => state.assets);
  const [enabled, setEnabled] = useProxiesEnabled();
  const { building, buildAll, cancel, busy } = useProxies();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Fixed to the window under the chip: the panel clips whatever overflows it.
  const [spot, setSpot] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const box = buttonRef.current?.getBoundingClientRect();
    if (!open || !box) return;
    setSpot({ left: Math.max(8, Math.min(box.left, window.innerWidth - 280)), top: box.bottom + 4 });
  }, [open]);

  const heavy = assets.filter(wantsProxy);
  if (heavy.length === 0) return null;

  const ready = heavy.length - heavy.filter((asset) => !asset.proxyUri).length;
  const pending = heavy.length - ready;

  return (
    <div ref={rootRef} data-testid="proxy-bar" className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="proxy-indicator"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`tool-button tool-button-dense gap-1 px-1.5 text-2xs tabular-nums ${open ? 'tool-button-active' : ''} ${
          ready === heavy.length ? 'text-emerald-300' : ''
        }`}
        onClick={() => setOpen((value) => !value)}
        // Short in the header ("0/3"); the whole name is its label and its tooltip.
        {...tip(t('proxy.label', { ready, total: heavy.length }), { hint: `${t('proxy.label', { ready, total: heavy.length })} - ${t('proxy.hint')}` })}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />}
        {ready}/{heavy.length}
      </button>

      <div
        role="dialog"
        aria-label={t('proxy.title')}
        data-state={open ? 'open' : 'closed'}
        hidden={!open}
        style={spot}
        className="scf-menu fixed z-[95] w-[272px] space-y-2.5 rounded-menu border border-panel-600 bg-panel-800 p-3 shadow-2xl shadow-black/60"
      >
        <p className="text-xs font-semibold text-slate-100">{t('proxy.title')}</p>
        <p className="text-2xs leading-relaxed text-slate-300">{proxySummary(assets, building, language)}</p>
        {busy ? (
          <button type="button" className="tool-button h-control border border-panel-600" onClick={cancel}>
            <X size={12} />
            {t('proxy.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="tool-button h-control border border-panel-600"
            data-testid="build-proxies"
            disabled={pending === 0}
            onClick={() => void buildAll()}
          >
            {pending === 0 ? t('proxy.allReady') : t('proxy.build', { count: pending })}
          </button>
        )}
        <label className="flex items-start gap-2 text-2xs leading-relaxed text-slate-300">
          <input
            type="checkbox"
            role="switch"
            className="mt-px"
            data-testid="use-proxies"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t('proxy.use')}
        </label>
      </div>
    </div>
  );
}
