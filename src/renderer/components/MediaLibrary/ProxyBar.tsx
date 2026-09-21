import { Gauge, X } from 'lucide-react';

import { proxySummary, wantsProxy } from '@renderer/media/proxyState';
import { useProxies, useProxiesEnabled } from '@renderer/media/useProxies';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The proxy strip above the media list.
 *
 * It only appears when there is footage heavy enough to need it - a project of
 * 720p clips has nothing to say here, and a control that does nothing is worse
 * than no control. What it says is exactly what is true: how many are ready,
 * what is building, and that the export reads the originals whatever this
 * switch is set to.
 */
export function ProxyBar(): JSX.Element | null {
  const assets = useProjectStore((state) => state.assets);
  const [enabled, setEnabled] = useProxiesEnabled();
  const { building, buildAll, cancel, busy } = useProxies();

  const heavy = assets.filter(wantsProxy);
  if (heavy.length === 0) return null;

  const pending = heavy.filter((asset) => !asset.proxyUri).length;

  return (
    <section data-testid="proxy-bar" className="border-b border-panel-700 px-3 py-2">
      <div className="flex items-center gap-2">
        <Gauge size={13} className="shrink-0 text-slate-400" />
        <span className="flex-1 text-2xs text-slate-400">{proxySummary(assets, building)}</span>
        {busy ? (
          <button type="button" className="tool-button h-7 shrink-0" onClick={cancel} title="Stop building">
            <X size={12} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="tool-button h-7 shrink-0"
            data-testid="build-proxies"
            disabled={pending === 0}
            title="Make small stand-ins for the heavy footage, for editing only"
            onClick={() => void buildAll()}
          >
            {pending === 0 ? 'Proxies ready' : `Build ${pending}`}
          </button>
        )}
      </div>

      <label className="mt-1.5 flex items-center gap-2 text-2xs text-slate-400">
        <input
          type="checkbox"
          className="accent-blue-500"
          data-testid="use-proxies"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Edit with proxies - the export always reads the original files
      </label>
    </section>
  );
}
