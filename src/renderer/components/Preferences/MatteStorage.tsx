import { useEffect } from 'react';
import { Eraser } from 'lucide-react';
import { MATTE_MODEL_IDS } from '@shared/types';
import { currentLocale, useT } from '@renderer/i18n';
import { MATTE_MODEL_NAME, useMattes } from '@renderer/matting/mattes';

/**
 * Preferences > Remove background: what it keeps on this computer - the
 * models downloaded, and the cache of analysed clips - with what each really
 * takes on disk, and the means to throw either away.
 *
 * Nothing is deleted from under an analysis. While one runs, the model it
 * uses and the cache cannot be deleted here, and the main process refuses as
 * well (main/matting/mattingIpc.ts): the person cancels the analysis in the
 * inspector first, and so knows what was stopped. Afterwards the effect
 * simply starts over - it asks to download the model again, or analyses the
 * clip again - as on a computer that never had them.
 */

/** Sizes as measured, with a decimal where a whole number would hide most of it. */
export function formatSize(bytes: number, locale: string): string {
  const number = (value: number, digits: number): string => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  if (bytes < 1_000_000) return `${number(bytes / 1000, 0)} KB`;
  if (bytes < 10_000_000) return `${number(bytes / 1_000_000, 1)} MB`;
  if (bytes < 1_000_000_000) return `${number(bytes / 1_000_000, 0)} MB`;
  return `${number(bytes / 1_000_000_000, 2)} GB`;
}

export function MatteStorage(): JSX.Element | null {
  const t = useT();
  const locale = currentLocale();
  const status = useMattes((state) => state.status);
  const downloading = useMattes((state) => state.downloading);
  // Asked again whenever an analysis starts or ends, so what is refused is
  // shown as refused, and the cache's size is the one on disk now.
  const running = useMattes((state) => Object.keys(state.jobs).length);

  useEffect(() => {
    void useMattes.getState().refresh();
  }, [running]);

  // A build without the bridge (a browser preview) has nothing to show.
  if (!status) return null;

  const busyModels = new Set(status.analysing);
  const busy = busyModels.size > 0 || running > 0;

  return (
    <section className="space-y-1.5" data-testid="matte-storage" aria-label={t('mattes.storageTitle')}>
      <h3 className="field-label flex items-center gap-1.5">
        <Eraser size={12} aria-hidden />
        {t('mattes.storageTitle')}
      </h3>
      <ul className="divide-y divide-panel-700 rounded-control border border-panel-700">
        {MATTE_MODEL_IDS.map((id) => {
          const model = status.models.find((candidate) => candidate.id === id);
          if (!model) return null;
          const refused = busyModels.has(id) || downloading?.id === id;
          return (
            <li key={id} className="flex items-center gap-2 px-2.5 py-2" data-testid={`matte-storage-model-${id}`} data-present={model.present} data-bytes={model.fileBytes}>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-100">
                  {t('mattes.modelLabel', { name: t(MATTE_MODEL_NAME[id]) })}
                  {model.present && <span className="text-slate-400"> · {formatSize(model.fileBytes, locale)}</span>}
                </p>
                <p className="text-2xs text-slate-400">{model.present ? t('captions.modelReady') : t('mattes.modelAbsent')}</p>
              </div>
              {model.present && (
                <button
                  type="button"
                  className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
                  data-testid={`matte-storage-delete-${id}`}
                  disabled={refused}
                  onClick={() => void useMattes.getState().deleteModel(id)}
                >
                  {t('captions.deleteModel')}
                </button>
              )}
            </li>
          );
        })}
        <li className="flex items-center gap-2 px-2.5 py-2" data-testid="matte-storage-cache" data-bytes={status.cache.bytes} data-files={status.cache.files}>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-100">
              {t('mattes.cacheTitle')} <span className="text-slate-400">· {formatSize(status.cache.bytes, locale)}</span>
            </p>
            <p className="text-2xs text-slate-400">{t('mattes.cacheFiles', { count: status.cache.files })}</p>
          </div>
          <button
            type="button"
            className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
            data-testid="matte-storage-clear"
            disabled={busy || status.cache.files === 0}
            onClick={() => void useMattes.getState().clearCache()}
          >
            {t('mattes.clearCache')}
          </button>
        </li>
      </ul>
      <p className="text-2xs leading-relaxed text-slate-400" role={busy ? 'status' : undefined}>
        {busy ? t('mattes.storageBusy') : t('mattes.storageHint')}
      </p>
    </section>
  );
}

export default MatteStorage;
