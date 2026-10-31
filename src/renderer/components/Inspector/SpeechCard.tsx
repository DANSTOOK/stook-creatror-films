import { useEffect, useState } from 'react';
import { Loader2, Mic } from 'lucide-react';
import type { Clip } from '@shared/types';
import { useT } from '@renderer/i18n';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { respeakClip } from '@renderer/tts/respeak';

/**
 * The script of a spoken clip, in the inspector: the words back in front of
 * you, editable, with the voice they were said in and a button to say them
 * again.
 *
 * Before this, a voice you did not like could only be deleted and the script
 * retyped into the panel - the clip was a sound with no memory of where it came
 * from. Now it keeps what it was asked to say (`Clip.speech`), so this can
 * offer it back. Clipchamp does the same, and it is the right place for it: the
 * thing you want to change is the clip you are looking at.
 *
 * What it says plainly, rather than letting it be a surprise: saying it again
 * makes a new clip, so a trim is lost, and it does not make captions a second
 * time.
 */

export function SpeechCard({ clip }: { clip: Clip }): JSX.Element | null {
  const t = useT();
  const [text, setText] = useState(clip.speech?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [fraction, setFraction] = useState(0);

  // A different clip selected: show ITS script, not the one being edited.
  useEffect(() => {
    setText(clip.speech?.text ?? '');
  }, [clip.id, clip.speech?.text]);

  const speech = clip.speech;
  if (!speech) return null;

  const changed = text.trim() !== speech.text.trim();
  const native = hasNativeBridge();

  const again = async (): Promise<void> => {
    if (!native || !text.trim()) return;
    setBusy(true);
    setFraction(0);
    try {
      const made = await respeakClip(clip.id, { ...speech, text }, setFraction);
      if (made) notify(t('speech.done'), 'success');
      else notify(t('speech.nothing'), 'error');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="clip-fx-speech" className="rounded-panel border border-panel-700 bg-panel-900/60 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Mic size={13} aria-hidden className="shrink-0 text-slate-400" />
        <h4 className="text-xs font-medium text-slate-200">{t('speech.title')}</h4>
      </div>
      <p className="mb-2 text-2xs leading-relaxed text-slate-400">{t('speech.hint')}</p>

      <textarea
        data-testid="clip-fx-speech-text"
        aria-label={t('speech.title')}
        className="mb-2 min-h-24 w-full resize-y rounded-control border border-panel-700 bg-panel-950 p-2 text-xs leading-relaxed text-slate-100 outline-none focus:border-accent/70"
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />

      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs text-slate-400">
        <dt>{t('speech.voice')}</dt>
        <dd data-testid="clip-fx-speech-voice" className="truncate text-slate-300">{speech.voice}</dd>
        <dt>{t('speech.speed')}</dt>
        <dd className="text-slate-300">{speech.speed.toFixed(2)}×</dd>
      </dl>

      <button
        type="button"
        data-testid="clip-fx-speech-again"
        className="flex w-full items-center justify-center gap-1.5 rounded-control bg-accent px-2 py-1 text-2xs font-medium text-panel-950 disabled:opacity-50"
        disabled={busy || !native || !text.trim()}
        onClick={() => void again()}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
        {busy ? `${Math.round(fraction * 100)} %` : t(changed ? 'speech.againChanged' : 'speech.again')}
      </button>
    </div>
  );
}
