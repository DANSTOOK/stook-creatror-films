import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import type { CaptionModelId } from '@shared/types/ipc';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { currentLocale, useT } from '@renderer/i18n';
import { MODEL_NAME, formatBytes, useCaptionModels } from '@renderer/captions/captionModels';

/**
 * The permission to download a speech model.
 *
 * The app never fetches a model on its own: this is asked every time one is
 * missing and wanted, and says what a person needs to decide - what it is,
 * how big, where it comes from, and that it is the only thing that travels:
 * the video and its sound stay here. Declining costs nothing; a model can
 * also be brought as a file from another computer.
 *
 * While it downloads, the same dialog shows how far along it is, and Cancel
 * stops it and leaves nothing behind.
 */
export interface ModelDownloadPromptProps {
  model: CaptionModelId;
  /** The model is on this computer now. */
  onReady(): void;
  onClose(): void;
}

export function ModelDownloadPrompt({ model, onReady, onClose }: ModelDownloadPromptProps): JSX.Element {
  const t = useT();
  const locale = currentLocale();
  const status = useCaptionModels((state) => state.status);
  const downloading = useCaptionModels((state) => state.downloading);
  const download = useCaptionModels((state) => state.download);
  const cancelDownload = useCaptionModels((state) => state.cancelDownload);
  const importFromFile = useCaptionModels((state) => state.importFromFile);

  const info = status?.models.find((candidate) => candidate.id === model);
  const size = formatBytes(info?.bytes ?? 0, locale);
  const busy = downloading !== null;
  const percent = downloading && downloading.total > 0 ? Math.min(100, Math.round((downloading.received / downloading.total) * 100)) : 0;

  const isReady = (): boolean => useCaptionModels.getState().status?.models.find((candidate) => candidate.id === model)?.present === true;

  // On the page itself, not inside whatever asked: a dialog that is still
  // animating in would carry this one along with it.
  return createPortal(
    <Dialog
      title={t('captions.downloadTitle')}
      icon={Download}
      role="alertdialog"
      onClose={() => {
        if (busy) cancelDownload();
        onClose();
      }}
      testId="captions-download-prompt"
      widthClass="w-[440px]"
      bodyClassName="space-y-2.5 p-4"
      zClass="z-[80]"
      initialFocus="dialog"
      footerStart={
        !busy && (
          <button
            type="button"
            className="tool-button"
            data-testid="captions-import-model"
            onClick={() => {
              void importFromFile().then((done) => {
                if (done && isReady()) onReady();
              });
            }}
          >
            {t('captions.importModel')}
          </button>
        )
      }
      footer={
        <>
          <button
            type="button"
            className="tool-button"
            data-testid="captions-download-cancel"
            onClick={() => {
              if (busy) cancelDownload();
              onClose();
            }}
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="captions-download-confirm"
            disabled={busy}
            onClick={() => {
              void download(model).then((ready) => {
                if (ready) onReady();
              });
            }}
          >
            {t('captions.download', { size })}
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-slate-200" data-testid="captions-download-body">
        {t('captions.downloadBody', { name: t(MODEL_NAME[model]), size, source: info?.source ?? '' })}
      </p>
      <p className="text-2xs leading-relaxed text-slate-400">{t('captions.downloadPrivacy')}</p>
      {busy && (
        <div className="space-y-1.5 pt-1" role="status">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-panel-700"
            role="progressbar"
            aria-label={t('captions.downloadTitle')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="scf-progress-bar h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <p className="text-2xs tabular-nums text-slate-400" data-testid="captions-download-progress">
            {t('captions.downloading', {
              percent,
              done: formatBytes(downloading?.received ?? 0, locale),
              total: formatBytes(downloading?.total ?? 0, locale),
            })}
          </p>
        </div>
      )}
    </Dialog>,
    document.body,
  );
}

export default ModelDownloadPrompt;
