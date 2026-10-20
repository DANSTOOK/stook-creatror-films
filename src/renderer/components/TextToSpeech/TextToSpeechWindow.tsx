import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Download, Loader2, PanelsTopLeft, Play, Trash2 } from 'lucide-react';
import type { TtsEngineStatus, TtsResult, TtsVoiceStatus } from '@shared/types/ipc';
import { TooltipLayer, tip } from '@renderer/components/Tooltip/Tooltip';
import { useDetachedWindow } from '@renderer/components/Layout/useDetachedWindow';
import { PanelEmptyState } from '@renderer/components/Layout/PanelEmptyState';
import { currentLocale, useLanguageStore, useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { buildAsset, hasNativeBridge } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { createId } from '@shared/utils/id';

/**
 * Timeline > Text to speech, in a window of its own.
 *
 * It used to be a modal dialog that blocked the editor until it was dismissed;
 * now it opens beside the editor in its own resizable window (the same
 * detachable-window mechanism the panels use, Layout/useDetachedWindow), so
 * the timeline stays live - scrub, trim, drop a clip - while the voice is set
 * up. The window remembers its size and place like the panels do, and its
 * header is the window's title bar, with the way back in it.
 *
 * Clipchamp's own voice tool is the shape to match: pick a language and a
 * voice, hear it, set the pace, then Generate - and the result lands on the
 * timeline as an audio clip. Here it lands at the playhead on a new audio
 * track of its own (the store renumbers default track names by layer), the
 * same place the media panel's "+" puts a clip. The window stays open after a
 * clip is made, so several lines can be generated without reopening it.
 *
 * Everything runs on this computer: the voices ship in the installer, so there
 * is nothing to download to use the bundled ones, and synthesis is the Piper
 * child process (main/tts). The engine adjusts speed but not pitch - a note
 * says so - and its bundled voices carry no use restrictions.
 */

const STORAGE_KEY = 'scf.tts.options';
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

interface Remembered {
  language?: 'es' | 'en';
  voice?: string;
  speed?: number;
}

function remembered(): Remembered {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Remembered;
    return {
      language: raw.language === 'es' || raw.language === 'en' ? raw.language : undefined,
      voice: typeof raw.voice === 'string' ? raw.voice : undefined,
      speed: typeof raw.speed === 'number' && raw.speed >= MIN_SPEED && raw.speed <= MAX_SPEED ? raw.speed : undefined,
    };
  } catch {
    return {};
  }
}

const formatBytes = (bytes: number, locale: string): string =>
  `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(bytes / 1_000_000))} MB`;

export interface TextToSpeechWindowProps {
  onClose(): void;
}

/** The form itself, drawn inside the window. */
function TextToSpeechBody({ onClose }: TextToSpeechWindowProps): JSX.Element {
  const t = useT();
  const locale = currentLocale();
  const uiLanguage = useLanguageStore((state) => state.language);
  const addAssets = useProjectStore((state) => state.addAssets);
  const addAssetOnNewTrack = useProjectStore((state) => state.addAssetOnNewTrack);
  const fps = useProjectStore((state) => state.project.fps);

  const saved = useMemo(remembered, []);
  const [status, setStatus] = useState<TtsEngineStatus | null>(null);
  const [language, setLanguage] = useState<'es' | 'en'>(saved.language ?? (uiLanguage === 'es' ? 'es' : 'en'));
  const [voiceId, setVoiceId] = useState<string>(saved.voice ?? '');
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(saved.speed ?? 1);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const jobRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = async (): Promise<void> => {
    const next = await window.filmora.ttsStatus?.();
    if (next) setStatus(next);
  };

  useEffect(() => {
    void refresh();
    const off = window.filmora.onTtsVoiceProgress?.((p) => {
      setDownloadingId(p.id);
      setDownloadPercent(p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0);
    });
    const offJob = window.filmora.onTtsProgress?.((p) => {
      if (p.jobId === jobRef.current) setProgress(p.fraction);
    });
    return () => {
      off?.();
      offJob?.();
      audioRef.current?.pause();
    };
  }, []);

  const voices = status?.voices ?? [];
  const voicesForLanguage = useMemo(() => voices.filter((v) => v.language === language), [voices, language]);

  // Keep a valid voice selected for the chosen language.
  useEffect(() => {
    if (voicesForLanguage.length === 0) return;
    if (!voicesForLanguage.some((v) => v.id === voiceId)) {
      const present = voicesForLanguage.find((v) => v.present) ?? voicesForLanguage[0];
      setVoiceId(present.id);
    }
  }, [voicesForLanguage, voiceId]);

  const voice: TtsVoiceStatus | undefined = voices.find((v) => v.id === voiceId);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language, voice: voiceId, speed }));
    } catch {
      // A private window may refuse storage; the choices just are not remembered.
    }
  }, [language, voiceId, speed]);

  const describeVoice = (v: TtsVoiceStatus): string =>
    v.present
      ? t('tts.voiceReady', { region: v.region, sex: t(v.sex === 'male' ? 'tts.male' : 'tts.female') })
      : t('tts.voiceDownloadable', { region: v.region, sex: t(v.sex === 'male' ? 'tts.male' : 'tts.female'), size: formatBytes(v.downloadBytes, locale) });

  const ensureVoice = async (): Promise<boolean> => {
    if (!voice || voice.present) return Boolean(voice);
    setDownloadingId(voice.id);
    setDownloadPercent(0);
    try {
      const next = await window.filmora.ttsVoiceDownload?.(voice.id);
      if (next) setStatus(next);
      return next?.voices.find((v) => v.id === voice.id)?.present === true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
      return false;
    } finally {
      setDownloadingId(null);
    }
  };

  const deleteVoice = async (id: string): Promise<void> => {
    const next = await window.filmora.ttsVoiceDelete?.(id);
    if (next) setStatus(next);
  };

  const preview = async (): Promise<void> => {
    if (!voice || previewing || generating) return;
    if (!(await ensureVoice())) return;
    setPreviewing(true);
    try {
      const url = await window.filmora.ttsPreview?.({ text, voice: voice.id, speed });
      if (url) {
        audioRef.current?.pause();
        const audio = new Audio(url);
        audioRef.current = audio;
        await audio.play();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const generate = async (): Promise<void> => {
    if (!voice || generating || !text.trim()) return;
    if (!(await ensureVoice())) return;
    setGenerating(true);
    setProgress(0);
    const jobId = createId('tts');
    jobRef.current = jobId;
    try {
      const result: TtsResult | undefined = await window.filmora.ttsGenerate?.(jobId, { text, voice: voice.id, speed });
      if (!result || result.cancelled || !result.path) return;
      const uri = await window.filmora.mediaUrl?.(result.path);
      if (!uri) throw new Error(t('tts.errorEngine', { detail: 'no media' }));
      const name = `${t('tts.title')} · ${voice.region}.wav`;
      const asset = await buildAsset({ name, uri, sourcePath: result.path }, fps);
      addAssets([asset]);
      addAssetOnNewTrack(asset);
      notify(t('tts.added', { name }), 'success');
      // The window stays open so another line can be generated at once; the
      // text is cleared, the voice and pace kept.
      setText('');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      jobRef.current = null;
      setGenerating(false);
    }
  };

  const cancel = (): void => {
    if (jobRef.current) void window.filmora.ttsCancel?.(jobRef.current);
    if (downloadingId) void window.filmora.ttsVoiceCancel?.(downloadingId);
  };

  const unavailable = !hasNativeBridge() || status?.available === false;
  const canGenerate = Boolean(voice) && text.trim().length > 0 && !generating && !previewing && downloadingId === null;

  return (
    <section data-testid="tts-dialog" className="panel h-full w-full">
      {/* This header is the window's title bar (useDetachedWindow turns it into
          one), so the way back lives in it, as the panels' do. */}
      <header className="panel-header">
        <AudioLines size={15} aria-hidden className="shrink-0 text-slate-300" />
        <span className="min-w-0 flex-1 truncate">{t('tts.title')}</span>
        <button
          type="button"
          data-testid="tts-close"
          className="tool-button tool-button-dense shrink-0 font-normal"
          onClick={() => {
            cancel();
            onClose();
          }}
          {...tip(t('panel.dock'), { named: false })}
        >
          <PanelsTopLeft size={13} aria-hidden />
          <span className="max-[519px]:sr-only">{t('panel.dockShort')}</span>
        </button>
      </header>

      {/* A column that fills the window: the text box takes whatever height
          the window has, so making the window taller gives the script more
          room instead of leaving a blank band under the controls. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {unavailable ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="tts-unavailable">
            <PanelEmptyState icon={AudioLines} title={t('tts.unavailable')} hint={t('tts.unavailableHint')} />
          </div>
        ) : (
          <>
            <label className="flex min-h-[7rem] flex-1 flex-col gap-1">
              <span className="field-label">{t('tts.text')}</span>
              <textarea
                className="input-field min-h-0 w-full flex-1 resize-none p-2 text-sm"
                placeholder={t('tts.textPlaceholder')}
                value={text}
                data-testid="tts-text"
                onChange={(event) => setText(event.target.value)}
              />
            </label>

            <div className="flex shrink-0 gap-3">
              <label className="flex-1 space-y-1">
                <span className="field-label">{t('tts.language')}</span>
                <select
                  className="input-field h-control w-full px-2 text-sm"
                  value={language}
                  data-testid="tts-language"
                  onChange={(event) => setLanguage(event.target.value === 'es' ? 'es' : 'en')}
                >
                  <option value="es">{t('tts.es')}</option>
                  <option value="en">{t('tts.en')}</option>
                </select>
              </label>
              <label className="flex-1 space-y-1">
                <span className="field-label">{t('tts.voice')}</span>
                <select
                  className="input-field h-control w-full px-2 text-sm"
                  value={voiceId}
                  data-testid="tts-voice"
                  onChange={(event) => setVoiceId(event.target.value)}
                >
                  {voicesForLanguage.map((v) => (
                    <option key={v.id} value={v.id}>
                      {`${v.region} · ${t(v.sex === 'male' ? 'tts.male' : 'tts.female')}${v.present ? '' : ` · ${formatBytes(v.downloadBytes, locale)}`}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {voice && (
              <div className="flex shrink-0 items-center justify-between text-xs text-panel-300">
                <span>{describeVoice(voice)}</span>
                <span className="flex items-center gap-2">
                  <span className="text-panel-400">{voice.licence}</span>
                  {!voice.bundled && voice.present && (
                    <button type="button" className="tool-button h-6 px-1.5" title={t('tts.delete')} onClick={() => void deleteVoice(voice.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {!voice.present && <Download className="h-3.5 w-3.5 text-panel-400" />}
                </span>
              </div>
            )}

            <label className="block shrink-0 space-y-1">
              <span className="flex items-center justify-between text-xs text-panel-200">
                <span className="field-label">{t('tts.speed')}</span>
                <span className="tabular-nums text-panel-300">{speed.toFixed(2)}×</span>
              </span>
              <input
                type="range"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.05}
                value={speed}
                data-testid="tts-speed"
                className="w-full"
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
            </label>

            {downloadingId && (
              <p className="text-xs text-panel-300" data-testid="tts-download-progress">
                {t('tts.downloading', { percent: String(downloadPercent) })}
              </p>
            )}

            <p className="shrink-0 text-xs text-panel-400">{t('tts.pitchNote')}</p>
            {status?.disclosureRequired && <p className="text-xs text-amber-300" data-testid="tts-disclosure">{t('tts.disclosure')}</p>}
          </>
        )}
      </div>

      {/* The action row sits on the window's bottom edge, like a panel's own bar. */}
      <footer className="panel-bar justify-end border-b-0 border-t border-[color:var(--hairline)]">
        <button
          type="button"
          className="tool-button h-control border border-panel-600 px-3"
          data-testid="tts-preview"
          disabled={!voice || previewing || generating || unavailable}
          onClick={() => void preview()}
        >
          {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          <span className="ml-1.5">{previewing ? t('tts.previewing') : t('tts.preview')}</span>
        </button>
        {generating ? (
          <button type="button" className="tool-button h-control border border-panel-600 px-3" data-testid="tts-cancel" onClick={cancel}>
            {t('tts.cancel')} {progress > 0 ? `· ${Math.round(progress * 100)}%` : ''}
          </button>
        ) : (
          <button
            type="button"
            className="tool-button tool-button--primary h-control px-3"
            data-testid="tts-generate"
            disabled={!canGenerate || unavailable}
            onClick={() => void generate()}
          >
            {t('tts.generate')}
          </button>
        )}
      </footer>
    </section>
  );
}

export function TextToSpeechWindow({ onClose }: TextToSpeechWindowProps): JSX.Element | null {
  const t = useT();
  const title = t('panel.windowTitle', { name: t('tts.title') });
  const { host, popout } = useDetachedWindow({ name: 'textToSpeech', title, onClose, width: 520, height: 560 });

  if (!host || !popout) return null;
  return createPortal(
    <div className="panel-window flex min-h-0 min-w-0 flex-1 [&>*]:min-w-0 [&>*]:flex-1" data-testid="panel-window-textToSpeech">
      <TextToSpeechBody onClose={onClose} />
      {/* Tips for the controls in this window, drawn in this window. */}
      <TooltipLayer view={popout} />
    </div>,
    host,
  );
}

export default TextToSpeechWindow;
