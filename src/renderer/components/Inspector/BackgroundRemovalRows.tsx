import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { MATTE_MODEL_IDS, type BackgroundRemovalConfig, type Clip, type MatteModelId, type MediaAsset } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { currentLocale, useT } from '@renderer/i18n';
import { formatBytes } from '@renderer/captions/captionModels';
import { MATTE_MODEL_NAME, declinedMattes as declined, matteEntry, useMattes } from '@renderer/matting/mattes';
import { SwitchRow } from './rows';

/**
 * Remove background, in the inspector: which model, and where the clip's
 * analysis stands - the model to download first, the analysis running (with
 * Cancel), done, or what went wrong.
 *
 * Turning the effect on starts the analysis by itself when the model is
 * already here, the way the effect would be expected to simply work; the
 * clip is drawn whole until it is done. Cancelling is remembered for the
 * clip's file, so the analysis does not start again behind the person's back.
 */

const MODEL_LABEL: Record<MatteModelId, MessageKey> = {
  precise: 'mattes.modelPrecise',
  fast: 'mattes.modelFast',
};

const perFrame = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export interface BackgroundRemovalRowsProps {
  clip: Clip;
  asset: MediaAsset | undefined;
  onChange(patch: Partial<BackgroundRemovalConfig>): void;
}

export function BackgroundRemovalRows({ clip, asset, onChange }: BackgroundRemovalRowsProps): JSX.Element {
  const t = useT();
  const locale = currentLocale();
  const { model, enabled } = clip.backgroundRemoval;
  const path = asset?.sourcePath;
  const entry = path ? matteEntry(path, model) : '';

  const status = useMattes((state) => state.status);
  const url = useMattes((state) => (entry ? state.urls[entry] : undefined));
  const job = useMattes((state) => (entry ? state.jobs[entry] : undefined));
  const error = useMattes((state) => (entry ? state.errors[entry] : undefined));
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void useMattes.getState().refresh();
  }, []);
  useEffect(() => {
    if (path && url === undefined) void useMattes.getState().lookup(path, model);
  }, [path, model, url]);

  const info = status?.models.find((candidate) => candidate.id === model);
  const usable = Boolean(asset && path && (asset.kind === 'video' || asset.kind === 'image'));

  // On, the model here, no mattes and nothing running: start - again as
  // soon as any of that changes (a model downloaded, the cache cleared).
  useEffect(() => {
    if (!enabled || !usable || !asset || !info?.present || url !== null || job || error) return;
    void useMattes.getState().ensureAnalysed(asset, model);
  }, [enabled, usable, asset, info?.present, url, job, error, model]);

  const percent = job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;

  let body: JSX.Element;
  if (!status?.available && status !== null) {
    body = <p className="text-2xs text-slate-400">{t('mattes.unavailable')}</p>;
  } else if (!usable) {
    body = <p className="text-2xs text-slate-400">{t('mattes.noFile')}</p>;
  } else if (info && !info.present) {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-slate-400">{t('mattes.needsModel', { name: t(MATTE_MODEL_NAME[model]) })}</p>
        <button type="button" className="tool-button tool-button-dense shrink-0 text-2xs" data-testid="matte-download" onClick={() => setAsking(true)}>
          <Download size={11} />
          {t('mattes.downloadShort', { size: formatBytes(info.bytes, locale) })}
        </button>
      </div>
    );
  } else if (job) {
    body = (
      <div className="space-y-1.5" role="status">
        <div className="h-1.5 overflow-hidden rounded-full bg-panel-700" role="progressbar" aria-label={t('inspector.backgroundRemoval')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="scf-progress-bar h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs tabular-nums text-slate-400" data-testid="matte-progress">
            {t('mattes.analysing', { percent, done: job.done, total: Math.max(job.done, job.total) })}
            {job.msPerFrame > 0 && job.device && <> · {t(job.device === 'gpu' ? 'mattes.speedGpu' : 'mattes.speedCpu', { ms: perFrame(job.msPerFrame) })}</>}
          </p>
          <button
            type="button"
            className="tool-button tool-button-dense shrink-0 text-2xs"
            data-testid="matte-cancel"
            onClick={() => {
              declined.add(entry);
              if (path) useMattes.getState().cancel(path, model);
            }}
          >
            {t('dialog.cancel')}
          </button>
        </div>
        {job.done > 0 && <p className="text-2xs leading-relaxed text-slate-400">{t('mattes.partialHint')}</p>}
      </div>
    );
  } else if (url) {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-slate-400" data-testid="matte-ready">
          {t('mattes.ready')}
        </p>
        <button
          type="button"
          className="tool-button tool-button-dense shrink-0 text-2xs hover:text-red-400"
          data-testid="matte-delete"
          onClick={() => {
            // Deleting is a decision: it is not analysed again until asked.
            declined.add(entry);
            if (path) void useMattes.getState().remove(path, model);
          }}
        >
          {t('mattes.deleteAnalysis')}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-1.5">
        {error && (
          <p className="text-2xs leading-relaxed text-red-300" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs text-slate-400">{t('mattes.notAnalysed')}</p>
          <button
            type="button"
            className="tool-button tool-button-dense shrink-0 text-2xs"
            data-testid="matte-analyse"
            disabled={!asset || url === undefined}
            onClick={() => {
              declined.delete(entry);
              if (asset) void useMattes.getState().analyse(asset, model);
            }}
          >
            {t('mattes.analyse')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <label className="grid grid-cols-[76px_1fr] items-center gap-2">
        <span className="field-label">{t('mattes.model')}</span>
        <select
          className="numeric-input h-control-dense"
          data-testid="matte-model"
          value={model}
          onChange={(event) => onChange({ model: event.target.value as MatteModelId })}
        >
          {MATTE_MODEL_IDS.map((id) => (
            <option key={id} value={id}>
              {t(MODEL_LABEL[id])}
            </option>
          ))}
        </select>
      </label>
      {model === 'precise' && <p className="text-2xs leading-relaxed text-slate-400">{t('mattes.preciseHint')}</p>}
      <SwitchRow label={t('mattes.invert')} checked={clip.backgroundRemoval.invert} onChange={(invert) => onChange({ invert })} />
      {clip.backgroundRemoval.invert && <p className="text-2xs leading-relaxed text-slate-400">{t('mattes.invertHint')}</p>}
      {body}
      {asking && <MatteModelPrompt model={model} onClose={() => setAsking(false)} />}
    </>
  );
}

/**
 * The permission to download a background model: what it is, how big, its
 * licence, where it comes from, and that only the model travels. Declining
 * costs nothing. While it downloads, the same dialog shows how far along it
 * is, and Cancel stops it and leaves nothing behind (main/subtitles/models).
 */
function MatteModelPrompt({ model, onClose }: { model: MatteModelId; onClose(): void }): JSX.Element {
  const t = useT();
  const locale = currentLocale();
  const status = useMattes((state) => state.status);
  const downloading = useMattes((state) => state.downloading);
  const info = status?.models.find((candidate) => candidate.id === model);
  const size = formatBytes(info?.bytes ?? 0, locale);
  const busy = downloading !== null;
  const percent = downloading && downloading.total > 0 ? Math.min(100, Math.round((downloading.received / downloading.total) * 100)) : 0;
  const stop = (): void => {
    if (busy) useMattes.getState().cancelDownload();
    onClose();
  };

  return createPortal(
    <Dialog
      title={t('mattes.downloadTitle')}
      icon={Download}
      role="alertdialog"
      onClose={stop}
      testId="matte-download-prompt"
      widthClass="w-[440px]"
      bodyClassName="space-y-2.5 p-4"
      zClass="z-[80]"
      initialFocus="dialog"
      footer={
        <>
          <button type="button" className="tool-button" onClick={stop}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="matte-download-confirm"
            disabled={busy}
            onClick={() => {
              void useMattes.getState().download(model).then((ready) => {
                if (ready) onClose();
              });
            }}
          >
            {t('mattes.download', { size })}
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-slate-200">
        {t('mattes.downloadBody', { name: t(MATTE_MODEL_NAME[model]), size, source: info?.source ?? '', licence: info?.licence ?? '' })}
      </p>
      <p className="text-2xs leading-relaxed text-slate-400">{t('mattes.downloadPrivacy')}</p>
      {busy && (
        <div className="space-y-1.5 pt-1" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-700" role="progressbar" aria-label={t('mattes.downloadTitle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="scf-progress-bar h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <p className="text-2xs tabular-nums text-slate-400">
            {t('captions.downloading', { percent, done: formatBytes(downloading?.received ?? 0, locale), total: formatBytes(downloading?.total ?? 0, locale) })}
          </p>
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
