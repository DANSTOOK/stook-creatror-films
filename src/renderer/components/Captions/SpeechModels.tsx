import { useEffect, useState } from 'react';
import { Captions } from 'lucide-react';
import type { CaptionModelId } from '@shared/types/ipc';
import { currentLocale, useT } from '@renderer/i18n';
import { MODEL_NAME, formatBytes, useCaptionModels } from '@renderer/captions/captionModels';
import { ModelDownloadPrompt } from './ModelDownloadPrompt';

/**
 * Preferences > Speech models: what is on this computer for generating
 * captions, and the means to get it, bring it as a file, or delete it.
 *
 * Download asks first, here as everywhere (ModelDownloadPrompt). Delete
 * needs no question: the model can be had again, and nothing of the user's
 * is in it.
 */
export function SpeechModels(): JSX.Element | null {
  const t = useT();
  const locale = currentLocale();
  const status = useCaptionModels((state) => state.status);
  const downloading = useCaptionModels((state) => state.downloading);
  const refresh = useCaptionModels((state) => state.refresh);
  const remove = useCaptionModels((state) => state.remove);
  const cancelDownload = useCaptionModels((state) => state.cancelDownload);
  const importFromFile = useCaptionModels((state) => state.importFromFile);
  const [asking, setAsking] = useState<CaptionModelId | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A build without the bridge (a browser preview) has nothing to show.
  if (!status) return null;

  return (
    <section className="space-y-1.5" data-testid="speech-models" aria-label={t('captions.modelsTitle')}>
      <h3 className="field-label flex items-center gap-1.5">
        <Captions size={12} aria-hidden />
        {t('captions.modelsTitle')}
      </h3>
      <ul className="divide-y divide-panel-700 rounded-control border border-panel-700">
        {status.models.map((model) => {
          const active = downloading?.id === model.id;
          const percent = active && downloading.total > 0 ? Math.round((downloading.received / downloading.total) * 100) : 0;
          return (
            <li key={model.id} className="flex items-center gap-2 px-2.5 py-2" data-testid={`speech-model-${model.id}`} data-present={model.present}>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-100">
                  {t(MODEL_NAME[model.id])} <span className="text-slate-400">· {formatBytes(model.bytes, locale)}</span>
                </p>
                <p className="text-2xs text-slate-400">
                  {active ? t('captions.downloadingShort', { percent }) : model.present ? t('captions.modelReady') : t('captions.modelAbsent')}
                </p>
              </div>
              {active ? (
                <button type="button" className="tool-button h-control-dense border border-panel-600 px-2 text-2xs" onClick={cancelDownload}>
                  {t('dialog.cancel')}
                </button>
              ) : model.present ? (
                <button
                  type="button"
                  className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
                  data-testid={`speech-model-delete-${model.id}`}
                  onClick={() => void remove(model.id)}
                >
                  {t('captions.deleteModel')}
                </button>
              ) : (
                <button
                  type="button"
                  className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
                  data-testid={`speech-model-download-${model.id}`}
                  disabled={downloading !== null}
                  onClick={() => setAsking(model.id)}
                >
                  {t('captions.downloadShort')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs leading-relaxed text-slate-400">
          {t('captions.modelsHint', { source: status.models[0]?.source ?? '' })}{' '}
          {status.available ? (status.gpu ? t('captions.engineGpu', { gpu: status.gpu }) : t('captions.engineCpu')) : t('captions.engineMissingShort')}
        </p>
        <button
          type="button"
          className="tool-button h-control-dense shrink-0 border border-panel-600 px-2 text-2xs"
          data-testid="speech-model-import"
          onClick={() => void importFromFile()}
        >
          {t('captions.importModel')}
        </button>
      </div>
      {asking && <ModelDownloadPrompt model={asking} onClose={() => setAsking(null)} onReady={() => setAsking(null)} />}
    </section>
  );
}

export default SpeechModels;
