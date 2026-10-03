import { useEffect, useId, useMemo, useState } from 'react';
import { Captions } from 'lucide-react';
import type { CaptionLanguage, CaptionPreset } from '@shared/types';
import type { CaptionModelId } from '@shared/types/ipc';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { currentLocale, useLanguageStore, useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useCaptionJob, type CaptionScope } from '@renderer/captions/captionJob';
import { glossaryPrompt, normalizeGlossary } from '@renderer/captions/glossary';
import { DEFAULT_MODEL, MODEL_NAME, formatBytes, useCaptionModels } from '@renderer/captions/captionModels';
import { ModelDownloadPrompt } from './ModelDownloadPrompt';

/**
 * Timeline > Generate captions.
 *
 * Four choices, as Resolve's "Create Subtitles from Audio" asks: the
 * language spoken, which sound to listen to, how carefully, and how the
 * captions are cut. Generate starts the job and closes the dialog - the
 * work goes on in the background (CaptionProgress) and the editor stays
 * usable. If the model chosen is not on this computer yet, the permission
 * to download it is asked first (ModelDownloadPrompt).
 *
 * The language is chosen, not detected: it starts on the interface's own,
 * and what is picked here is remembered for next time, like the rest.
 *
 * Then, when they apply: what stretch to listen to (the whole timeline, the
 * marked range, or the selected clips), which captions track to put them on
 * (a new one, or one that has some - its captions in that stretch are
 * replaced), the project's names and terms (its glossary, which leans
 * Whisper's spelling), and the voice detector, on unless switched off.
 */

const STORAGE_KEY = 'scf.captions.options';

interface Remembered {
  language?: CaptionLanguage;
  model?: CaptionModelId;
  preset?: CaptionPreset;
  vad?: boolean;
}

function remembered(): Remembered {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Remembered;
    return {
      language: raw.language === 'es' || raw.language === 'en' ? raw.language : undefined,
      model: raw.model === 'precise' || raw.model === 'fast' ? raw.model : undefined,
      preset: raw.preset === 'classic' || raw.preset === 'social' ? raw.preset : undefined,
      vad: typeof raw.vad === 'boolean' ? raw.vad : undefined,
    };
  } catch {
    return {};
  }
}

export interface GenerateCaptionsDialogProps {
  onClose(): void;
  closing?: boolean;
}

export function GenerateCaptionsDialog({ onClose, closing = false }: GenerateCaptionsDialogProps): JSX.Element {
  const t = useT();
  const locale = currentLocale();
  const uiLanguage = useLanguageStore((state) => state.language);
  const tracks = useProjectStore((state) => state.project.tracks);
  const clips = useProjectStore((state) => state.project.clips);
  const assets = useProjectStore((state) => state.assets);
  const portrait = useProjectStore((state) => state.project.width < state.project.height);
  const inFrame = useProjectStore((state) => state.ui.inFrame);
  const outFrame = useProjectStore((state) => state.ui.outFrame);
  const selectedClipIds = useProjectStore((state) => state.ui.selectedClipIds);
  const savedGlossary = useProjectStore((state) => state.project.glossary);
  const setGlossary = useProjectStore((state) => state.setGlossary);
  const status = useCaptionModels((state) => state.status);
  const refresh = useCaptionModels((state) => state.refresh);
  const start = useCaptionJob((state) => state.start);
  const busy = useCaptionJob((state) => state.phase !== 'idle');

  const saved = useMemo(remembered, []);
  const [language, setLanguage] = useState<CaptionLanguage>(saved.language ?? uiLanguage);
  const [source, setSource] = useState<'mix' | string>('mix');
  const [model, setModel] = useState<CaptionModelId>(saved.model ?? DEFAULT_MODEL);
  // A tall frame is phone video: it starts on the one-line style.
  const [preset, setPreset] = useState<CaptionPreset>(saved.preset ?? (portrait ? 'social' : 'classic'));
  const [asking, setAsking] = useState(false);
  const [vad, setVad] = useState(saved.vad ?? true);
  const [glossary, setGlossaryText] = useState((savedGlossary ?? []).join('\n'));
  const [into, setInto] = useState<string>('new');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Tracks that have sound on them: video clips with a file, or anything on an audio track. */
  const soundTracks = useMemo(() => {
    const kinds = new Map(assets.map((asset) => [asset.uri, asset.kind]));
    const withSound = new Set(
      Object.values(clips)
        .filter((clip) => {
          const kind = kinds.get(clip.sourceUri);
          return kind === 'video' || kind === 'audio';
        })
        .map((clip) => clip.trackId),
    );
    return tracks.filter((track) => withSound.has(track.id)).sort((a, b) => b.order - a.order);
  }, [assets, clips, tracks]);

  /** Selected clips with sound: what "the selected clips" means here. */
  const heardSelection = useMemo(() => {
    const kinds = new Map(assets.map((asset) => [asset.uri, asset.kind]));
    return selectedClipIds.filter((id) => {
      const clip = clips[id];
      const kind = clip ? kinds.get(clip.sourceUri) : undefined;
      return Boolean(clip) && !clip.caption && (kind === 'video' || kind === 'audio');
    });
  }, [assets, clips, selectedClipIds]);
  const marked = inFrame !== null && outFrame !== null && outFrame > inFrame;
  const [scopeKind, setScopeKind] = useState<CaptionScope['kind']>(heardSelection.length > 0 ? 'clips' : marked ? 'range' : 'all');
  const captionTracks = useMemo(() => tracks.filter((track) => track.type === 'captions').sort((a, b) => b.order - a.order), [tracks]);

  const languageId = useId();
  const scopeId = useId();
  const intoId = useId();
  const glossaryId = useId();
  const glossaryHintId = useId();
  const vadId = useId();
  const sourceId = useId();
  const modelId = useId();
  const presetId = useId();
  const hintId = useId();

  const engineMissing = status !== null && !status.available;
  const present = status?.models.find((candidate) => candidate.id === model)?.present === true;

  const generate = (): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language, model, preset, vad } satisfies Remembered));
    } catch {
      // Not remembered; nothing else changes.
    }
    const terms = normalizeGlossary(glossary);
    setGlossary(terms);
    const scope: CaptionScope =
      scopeKind === 'clips' && heardSelection.length > 0
        ? { kind: 'clips', clipIds: heardSelection }
        : scopeKind === 'range' && marked
          ? { kind: 'range', from: inFrame as number, to: outFrame as number }
          : { kind: 'all' };
    onClose();
    void start({
      language,
      source,
      model,
      preset,
      scope,
      intoTrackId: into === 'new' ? null : into,
      prompt: glossaryPrompt(terms),
      vad: status?.vad ? vad : undefined,
    });
  };

  return (
    <>
      <Dialog
        title={t('captions.title')}
        icon={Captions}
        onClose={onClose}
        closing={closing}
        testId="captions-dialog"
        widthClass="w-[460px]"
        bodyClassName="space-y-3 p-4"
        footer={
          <>
            <button type="button" className="tool-button" onClick={onClose}>
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button-primary"
              data-testid="captions-generate"
              disabled={engineMissing || busy || status === null}
              onClick={() => (present ? generate() : setAsking(true))}
            >
              {t('captions.generate')}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={languageId} className="field-label">
            {t('captions.language')}
          </label>
          <select
            id={languageId}
            className="numeric-input"
            data-testid="captions-language"
            aria-describedby={hintId}
            value={language}
            onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'es')}
          >
            <option value="es" lang="es">
              Español
            </option>
            <option value="en" lang="en">
              English
            </option>
          </select>
          <p id={hintId} className="text-2xs leading-relaxed text-slate-400">
            {t('captions.languageHint')}
          </p>
        </div>

        {(marked || heardSelection.length > 0) && (
          <div className="flex flex-col gap-1">
            <label htmlFor={scopeId} className="field-label">
              {t('captions.scope')}
            </label>
            <select
              id={scopeId}
              className="numeric-input"
              data-testid="captions-scope"
              value={scopeKind}
              onChange={(event) => setScopeKind(event.target.value as CaptionScope['kind'])}
            >
              <option value="all">{t('captions.scopeAll')}</option>
              {marked && <option value="range">{t('captions.scopeRange')}</option>}
              {heardSelection.length > 0 && <option value="clips">{t('captions.scopeClips', { count: heardSelection.length })}</option>}
            </select>
          </div>
        )}

        {scopeKind !== 'clips' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={sourceId} className="field-label">
            {t('captions.source')}
          </label>
          <select id={sourceId} className="numeric-input" data-testid="captions-source" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="mix">{t('captions.sourceMix')}</option>
            {soundTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {t('captions.sourceTrack', { name: track.name })}
              </option>
            ))}
          </select>
        </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={modelId} className="field-label">
            {t('captions.quality')}
          </label>
          <select
            id={modelId}
            className="numeric-input"
            data-testid="captions-model"
            value={model}
            onChange={(event) => setModel(event.target.value === 'fast' ? 'fast' : 'precise')}
          >
            {(['precise', 'fast'] as const).map((id) => {
              const info = status?.models.find((candidate) => candidate.id === id);
              const state = info?.present ? t('captions.modelReady') : t('captions.modelMissing', { size: formatBytes(info?.bytes ?? 0, locale) });
              return (
                <option key={id} value={id}>
                  {`${t(MODEL_NAME[id])} - ${t(id === 'precise' ? 'captions.modelPreciseHint' : 'captions.modelFastHint')} (${state})`}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={presetId} className="field-label">
            {t('captions.style')}
          </label>
          <select
            id={presetId}
            className="numeric-input"
            data-testid="captions-preset"
            value={preset}
            onChange={(event) => setPreset(event.target.value === 'social' ? 'social' : 'classic')}
          >
            <option value="classic">{t('captions.presetClassic')}</option>
            <option value="social">{t('captions.presetSocial')}</option>
          </select>
        </div>

        {captionTracks.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={intoId} className="field-label">
              {t('captions.into')}
            </label>
            <select id={intoId} className="numeric-input" data-testid="captions-into" value={into} onChange={(event) => setInto(event.target.value)}>
              <option value="new">{t('captions.intoNew')}</option>
              {captionTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {t('captions.intoTrack', { name: track.name })}
                </option>
              ))}
            </select>
            {into !== 'new' && <p className="text-2xs leading-relaxed text-slate-400">{t('captions.intoHint')}</p>}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={glossaryId} className="field-label">
            {t('captions.glossary')}
          </label>
          <textarea
            id={glossaryId}
            data-testid="captions-glossary"
            aria-describedby={glossaryHintId}
            rows={2}
            spellCheck={false}
            className="numeric-input min-h-[44px] resize-y py-1 leading-snug"
            placeholder={t('captions.glossaryPlaceholder')}
            value={glossary}
            onChange={(event) => setGlossaryText(event.target.value)}
          />
          <p id={glossaryHintId} className="text-2xs leading-relaxed text-slate-400">
            {t('captions.glossaryHint')}
          </p>
        </div>

        {status?.vad && (
          <label htmlFor={vadId} className="flex items-start gap-2 text-2xs leading-relaxed text-slate-300">
            <input id={vadId} type="checkbox" role="switch" className="mt-px" data-testid="captions-vad" checked={vad} onChange={(event) => setVad(event.target.checked)} />
            <span>
              {t('captions.vad')}
              <span className="block text-slate-400">{t(vad ? 'captions.vadOn' : 'captions.vadOff')}</span>
            </span>
          </label>
        )}

        {engineMissing ? (
          <p role="alert" className="text-2xs leading-relaxed text-amber-200" data-testid="captions-engine-missing">
            {t('captions.engineMissing')}
          </p>
        ) : (
          <p className="text-2xs leading-relaxed text-slate-400" data-testid="captions-engine">
            {t('captions.privacy')} {status ? (status.gpu ? t('captions.engineGpu', { gpu: status.gpu }) : t('captions.engineCpu')) : ''}
          </p>
        )}
      </Dialog>

      {asking && (
        <ModelDownloadPrompt
          model={model}
          onClose={() => setAsking(false)}
          onReady={() => {
            setAsking(false);
            generate();
          }}
        />
      )}
    </>
  );
}

export default GenerateCaptionsDialog;
