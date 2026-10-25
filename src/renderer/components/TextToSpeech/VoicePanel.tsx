import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Check, Loader2, Play, Sparkles, Square, Timer, Wand2 } from 'lucide-react';
import type { TtsEffect, TtsEngineStatus, TtsVoiceStatus } from '@shared/types/ipc';
import type { MessageKey } from '@shared/i18n';
import { PanelEmptyState } from '@renderer/components/Layout/PanelEmptyState';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useLanguageStore, useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { MAX_SPEED, MIN_SPEED, rememberTtsOptions, speakText, ttsOptions } from '@renderer/tts/speak';
import { VOICE_CHARACTERS, VOICE_EFFECTS, type VoiceCharacter } from '@renderer/tts/characters';
import { createId } from '@shared/utils/id';
import { insertMark, PAUSE_CHOICES, pauseLabel, pauseMark, pauseMarks, pauseSeconds, scriptWords } from '@shared/tts/script';
import { notify } from '@renderer/notifications/notifications';
import { errorText } from '@renderer/errorText';
import { VoiceAvatar } from './VoiceAvatar';

/**
 * The library's Voice tab: text to speech beside Effects and Transitions,
 * as CapCut's and Filmora's are - not a window over the editor. Write the
 * script, pick a character (a voice, a pace, a pitch and a style at once) or
 * a voice and a style of one's own, hear it, and Generate: an audio clip of
 * exactly that text lands at the playhead on a Voice track. Captions of it
 * are an option, off unless ticked.
 *
 * The voices ship in the installer (main/tts/catalog.ts): Kokoro's, the most
 * natural, and Piper's, the quickest. Everything runs on this computer.
 */

const SEX: Record<TtsVoiceStatus['sex'], MessageKey> = { male: 'tts.male', female: 'tts.female' };

function Chip({ active, onClick, children, testId, hint }: { active: boolean; onClick(): void; children: React.ReactNode; testId: string; hint?: string }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      className={`tool-button tool-button-dense h-auto min-h-7 justify-center px-2 py-1 text-center text-2xs leading-tight ${active ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
      onClick={onClick}
      {...(hint ? tip(hint, { named: false }) : {})}
    >
      {children}
    </button>
  );
}

/**
 * The script box: a textarea over a copy of its text in which every pause
 * mark is a cyan chip, so a pause reads as a pause and not as words. The copy
 * wraps exactly as the box does - the same font, padding and scrollbar gutter
 * (index.css .scf-script-box) - and scrolls with it.
 */
function ScriptBox({ value, onChange, placeholder, boxRef }: { value: string; onChange(value: string): void; placeholder: string; boxRef: React.RefObject<HTMLTextAreaElement> }): JSX.Element {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const pieces = useMemo(() => {
    const out: Array<{ text: string; mark: boolean }> = [];
    let at = 0;
    for (const mark of pauseMarks(value)) {
      if (mark.start > at) out.push({ text: value.slice(at, mark.start), mark: false });
      out.push({ text: value.slice(mark.start, mark.end), mark: true });
      at = mark.end;
    }
    if (at < value.length) out.push({ text: value.slice(at), mark: false });
    return out;
  }, [value]);
  return (
    <div className="relative rounded-control border border-panel-700 bg-panel-950 focus-within:border-accent">
      <div ref={mirrorRef} aria-hidden data-testid="tts-text-marks" className="scf-script-box pointer-events-none absolute inset-0 overflow-hidden text-transparent">
        {pieces.map((piece, index) =>
          piece.mark ? (
            // eslint-disable-next-line react/no-array-index-key
            <mark key={index} className="rounded-sm bg-accent/25 text-transparent ring-1 ring-accent/60">
              {piece.text}
            </mark>
          ) : (
            // eslint-disable-next-line react/no-array-index-key
            <span key={index}>{piece.text}</span>
          ),
        )}
        {/* A last empty line still has a height, as the box's does. */}
        {'\u200b'}
      </div>
      <textarea
        ref={boxRef}
        className="scf-script-box relative block h-28 w-full resize-y overflow-y-auto bg-transparent text-slate-100 outline-none placeholder:text-slate-500"
        placeholder={placeholder}
        value={value}
        data-testid="tts-text"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

export function VoicePanel(): JSX.Element {
  const t = useT();
  const uiLanguage = useLanguageStore((state) => state.language);
  const saved = useMemo(() => ttsOptions(uiLanguage), [uiLanguage]);
  const [status, setStatus] = useState<TtsEngineStatus | null>(null);
  const [language, setLanguage] = useState<'es' | 'en'>(saved.language);
  const [voiceId, setVoiceId] = useState<string>(saved.voice);
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(saved.speed);
  const [pitch, setPitch] = useState(saved.pitch);
  const [effect, setEffect] = useState<TtsEffect>(saved.effect);
  const [enhance, setEnhance] = useState(saved.enhance);
  const [captions, setCaptions] = useState(saved.captions);
  const [character, setCharacter] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const jobRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const spoken = useMemo(() => scriptWords(text), [text]);
  const pauses = useMemo(() => ({ count: pauseMarks(text).length, seconds: pauseSeconds(text) }), [text]);

  /** A pause written where the caret is (over the selection), the caret put after it and the box kept in focus. */
  const insertPause = (seconds: number): void => {
    const box = textRef.current;
    const next = insertMark(text, box?.selectionStart ?? text.length, box?.selectionEnd ?? text.length, pauseMark(seconds, language));
    setText(next.text);
    window.requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  useEffect(() => {
    void window.filmora?.ttsStatus?.().then((next) => next && setStatus(next));
    const offJob = window.filmora?.onTtsProgress?.((event) => {
      if (event.jobId === jobRef.current) setProgress(event.fraction);
    });
    return () => {
      offJob?.();
      audioRef.current?.pause();
    };
  }, []);

  const voices = useMemo(() => (status?.voices ?? []).filter((voice) => voice.present), [status]);
  const forLanguage = useMemo(() => voices.filter((voice) => voice.language === language), [voices, language]);
  const voice = forLanguage.find((candidate) => candidate.id === voiceId) ?? forLanguage[0];

  useEffect(() => {
    rememberTtsOptions({ language, voice: voice?.id ?? voiceId, speed, pitch, enhance, captions, effect });
  }, [language, voice, voiceId, speed, pitch, enhance, captions, effect]);

  /** The voice a character speaks with in the script's language: its English one for English. */
  const characterVoice = (chosen: VoiceCharacter): string => (language === 'en' && chosen.voiceEn ? chosen.voiceEn : chosen.voice);
  /** A character: its voice (or the closest here), pace, pitch and style. */
  const pick = (chosen: VoiceCharacter): void => {
    const wanted = voices.find((candidate) => candidate.id === characterVoice(chosen)) ?? voices.find((candidate) => candidate.language === language);
    if (wanted) {
      setLanguage(wanted.language);
      setVoiceId(wanted.id);
    }
    setSpeed(chosen.speed);
    setPitch(chosen.pitch);
    setEffect(chosen.effect);
    setCharacter(chosen.id);
  };
  /** What a character sets, for its card's tooltip: the voice, the pace and the style. */
  const characterHint = (chosen: VoiceCharacter): string => {
    const name = voices.find((candidate) => candidate.id === characterVoice(chosen))?.name;
    const style = VOICE_EFFECTS.find((entry) => entry.id === chosen.effect)?.label ?? 'tts.effect.none';
    return [name, `${chosen.speed.toFixed(2)}×`, t(style)].filter(Boolean).join(' · ');
  };
  /** Anything changed by hand: no character is chosen any more. */
  const own = <T,>(set: (value: T) => void) => (value: T): void => {
    set(value);
    setCharacter(null);
  };

  const preview = async (who: TtsVoiceStatus): Promise<void> => {
    if (previewing || generating) return;
    audioRef.current?.pause();
    setPreviewing(who.id);
    try {
      // The script's first line, or the voice introducing itself.
      const line = text.trim() || t('tts.sample', { name: who.name });
      const url = await window.filmora.ttsPreview?.({ text: line, voice: who.id, speed, pitch, enhance, effect });
      if (url) {
        const audio = new Audio(url);
        audioRef.current = audio;
        await audio.play();
      }
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      setPreviewing(null);
    }
  };

  const generate = async (): Promise<void> => {
    if (!voice || generating || !spoken.trim()) return;
    setGenerating(true);
    setProgress(0);
    const jobId = createId('tts');
    jobRef.current = jobId;
    try {
      const start = useProjectStore.getState().project.currentFrame;
      const clipId = await speakText(text, start, { language, voice: voice.id, speed, pitch, enhance, captions, effect }, voice.id, setProgress, jobId);
      if (clipId) notify(t('tts.added', { name: voice.name }), 'success');
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      jobRef.current = null;
      setGenerating(false);
    }
  };

  const cancel = (): void => {
    if (jobRef.current) void window.filmora.ttsCancel?.(jobRef.current);
  };

  if (!hasNativeBridge() || status?.available === false) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="tts-unavailable">
        <PanelEmptyState icon={AudioLines} title={t('tts.unavailable')} hint={t('tts.unavailableHint')} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tts-dialog">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className="field-label flex items-center justify-between">
              {t('tts.text')}
              {/* What is said: the pause marks are not counted as words. */}
              <span className="tabular-nums text-slate-500" data-testid="tts-text-count">
                {spoken.length}
              </span>
            </span>
            <ScriptBox value={text} onChange={setText} placeholder={t('tts.textPlaceholder')} boxRef={textRef} />
          </label>
          {/*
            Pauses, as a voice-over script marks them: one click writes
            [pausa 1s] where the caret is, and the voice is silent there for
            exactly that long (shared/tts/script).
          */}
          <div className="flex flex-wrap items-center gap-1" data-testid="tts-pauses">
            <span className="field-label mr-0.5 flex items-center gap-1" {...tip(t('tts.pause'), { hint: t('tts.pauseHint'), named: false })}>
              <Timer size={12} aria-hidden />
              {t('tts.pause')}
            </span>
            {PAUSE_CHOICES.map((seconds) => (
              <button
                key={seconds}
                type="button"
                data-testid={`tts-pause-${seconds}`}
                className="tool-button tool-button-dense h-6 border border-panel-700 px-1.5 text-2xs tabular-nums"
                aria-label={t('tts.pauseAdd', { seconds: pauseLabel(seconds, uiLanguage) })}
                // The box keeps the focus, and with it the caret the pause goes at.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertPause(seconds)}
                {...tip(t('tts.pauseAdd', { seconds: pauseLabel(seconds, uiLanguage) }), { hint: t('tts.pauseHint'), named: false })}
              >
                {pauseLabel(seconds, uiLanguage)} s
              </button>
            ))}
            {pauses.count > 0 && (
              <span className="ml-auto text-2xs tabular-nums text-accent-hover" data-testid="tts-pause-total">
                {t(pauses.count === 1 ? 'tts.pauseOne' : 'tts.pausesMany', { count: pauses.count, seconds: pauseLabel(pauses.seconds, uiLanguage) })}
              </span>
            )}
          </div>
        </div>

        <section className="space-y-1.5">
          <h3 className="field-label flex items-center gap-1.5">
            <Sparkles size={12} aria-hidden />
            {t('tts.characters')}
          </h3>
          {/* Cards with a face each, as CapCut's voice characters: the face tells them apart before the name is read. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5" data-testid="tts-characters">
            {VOICE_CHARACTERS.map((item) => {
              const active = character === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`tts-character-${item.id}`}
                  aria-pressed={active}
                  className={`scf-voice-card flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 pb-1.5 pt-2 text-center ring-1 transition-colors ${
                    active ? 'bg-accent/15 ring-accent' : 'bg-panel-900 ring-panel-700 hover:bg-panel-800 hover:ring-panel-600'
                  }`}
                  onClick={() => pick(item)}
                  {...tip(t(item.label), { hint: characterHint(item), named: false })}
                >
                  <span className="relative">
                    <VoiceAvatar character={item.id} className="scf-voice-avatar block h-11 w-11" />
                    {active && (
                      <span aria-hidden className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-accent-contrast ring-2 ring-panel-900">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 w-full break-words text-2xs leading-tight text-slate-200">{t(item.label)}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center gap-2">
            <h3 className="field-label flex-1">{t('tts.voice')}</h3>
            <select
              className="input-field h-6 px-1 text-2xs"
              value={language}
              data-testid="tts-language"
              aria-label={t('tts.language')}
              onChange={(event) => own(setLanguage)(event.target.value === 'en' ? 'en' : 'es')}
            >
              <option value="es">{t('tts.es')}</option>
              <option value="en">{t('tts.en')}</option>
            </select>
          </div>
          <ul className="space-y-1" role="radiogroup" aria-label={t('tts.voice')}>
            {forLanguage.map((item) => {
              const chosen = item.id === voice?.id;
              return (
                <li key={item.id}>
                  <div
                    role="radio"
                    aria-checked={chosen}
                    tabIndex={0}
                    data-testid={`tts-voice-${item.id}`}
                    className={`flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 ring-1 ${chosen ? 'bg-accent/15 ring-accent' : 'bg-panel-900 ring-panel-700 hover:ring-panel-600'}`}
                    onClick={() => own(setVoiceId)(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        own(setVoiceId)(item.id);
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs text-slate-100">
                        {item.name}
                        <span className="rounded bg-panel-800 px-1 text-[10px] uppercase tracking-wide text-slate-400">
                          {t(item.engine === 'kokoro' ? 'tts.engineNatural' : 'tts.engineQuick')}
                        </span>
                      </span>
                      <span className="block truncate text-2xs text-slate-400">
                        {item.region} · {t(SEX[item.sex])} · {t(`tts.persona.${item.persona}` as MessageKey)}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-testid={`tts-voice-preview-${item.id}`}
                      className="tool-button tool-button-dense w-7 shrink-0 justify-center px-0"
                      aria-label={t('tts.previewVoice', { name: item.name })}
                      disabled={generating || (previewing !== null && previewing !== item.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        void preview(item);
                      }}
                    >
                      {previewing === item.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1.5">
          <h3 className="field-label flex items-center gap-1.5">
            <Wand2 size={12} aria-hidden />
            {t('tts.style')}
          </h3>
          <div className="grid grid-cols-3 gap-1">
            {VOICE_EFFECTS.map((item) => (
              <Chip key={item.id} testId={`tts-effect-${item.id}`} active={effect === item.id} onClick={() => own(setEffect)(item.id)}>
                {t(item.label)}
              </Chip>
            ))}
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="flex items-center justify-between">
              <span className="field-label">{t('tts.speed')}</span>
              <span className="text-2xs tabular-nums text-slate-300">{speed.toFixed(2)}×</span>
            </span>
            <input type="range" min={MIN_SPEED} max={MAX_SPEED} step={0.05} value={speed} data-testid="tts-speed" className="w-full" onChange={(event) => own(setSpeed)(Number(event.target.value))} />
          </label>
          <label className="block space-y-1">
            <span className="flex items-center justify-between">
              <span className="field-label">{t('tts.pitch')}</span>
              <span className="text-2xs tabular-nums text-slate-300">
                {pitch > 0 ? '+' : ''}
                {pitch}
              </span>
            </span>
            <input type="range" min={-6} max={6} step={0.5} value={pitch} data-testid="tts-pitch" className="w-full" onChange={(event) => own(setPitch)(Number(event.target.value))} />
          </label>
        </div>

        <div className="space-y-1.5 text-xs text-slate-200">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" data-testid="tts-enhance" checked={enhance} onChange={(event) => setEnhance(event.target.checked)} />
            {t('tts.enhance')}
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" data-testid="tts-captions" checked={captions} onChange={(event) => setCaptions(event.target.checked)} />
            {t('tts.captions')}
          </label>
        </div>
        {voice && <p className="text-[10px] leading-relaxed text-slate-500">{t('tts.licence', { name: voice.name, licence: voice.licence })}</p>}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-[color:var(--hairline)] p-2">
        <p className="min-w-0 flex-1 truncate text-2xs text-slate-400">{t('tts.generateHint')}</p>
        {generating ? (
          <button type="button" className="tool-button h-control border border-panel-600 px-3" data-testid="tts-cancel" onClick={cancel}>
            <Square size={12} aria-hidden />
            {t('tts.cancel')} {progress > 0 ? `· ${Math.round(progress * 100)}%` : ''}
          </button>
        ) : (
          <button type="button" className="button-primary h-control px-4" data-testid="tts-generate" disabled={!voice || !spoken.trim() || previewing !== null} onClick={() => void generate()}>
            <AudioLines size={14} aria-hidden />
            {t('tts.generate')}
          </button>
        )}
      </footer>
    </div>
  );
}
