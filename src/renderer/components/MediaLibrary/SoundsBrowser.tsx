import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Music2, Pause, Play, Plus, Zap } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { SOUNDS, type Sound, type SoundCategory } from '@renderer/sounds/catalog';
import { soundSeconds } from '@renderer/sounds/synth';
import { addSound, soundPreviewUrl } from '@renderer/sounds/addSound';

/**
 * The Sounds tab of the library: sound effects and music, every one made in
 * the editor and free to use anywhere (sounds/catalog). Play hears it;
 * the row (or +) puts it at the playhead on an audio track of its own.
 */

const GROUPS: Array<{ category: SoundCategory; label: 'sound.groupEffects' | 'sound.groupMusic'; icon: typeof Zap }> = [
  { category: 'effects', label: 'sound.groupEffects', icon: Zap },
  { category: 'music', label: 'sound.groupMusic', icon: Music2 },
];

const clock = (seconds: number): string => (seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`);

export function SoundsBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const preview = async (sound: Sound): Promise<void> => {
    if (playing === sound.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    setBusy(sound.id);
    try {
      const url = await soundPreviewUrl(sound.id);
      if (!url) return;
      const audio = new Audio(url);
      audio.onended = () => setPlaying(null);
      audioRef.current = audio;
      setPlaying(sound.id);
      await audio.play().catch(() => setPlaying(null));
    } finally {
      setBusy(null);
    }
  };

  const add = async (sound: Sound): Promise<void> => {
    if (!hasNativeBridge()) return;
    setBusy(sound.id);
    try {
      const clipId = await addSound(sound.id);
      if (clipId) notify(t('sound.added', { name: t(sound.label) }), 'success');
    } catch (error) {
      notify(t('sound.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="library-sounds" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <p id={hintId} className="mb-2 px-1 text-2xs leading-relaxed text-slate-400">
        {t('sound.hint')}
      </p>
      {GROUPS.map((group) => (
        <section key={group.category} className="mb-3">
          <h3 className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-200">
            <group.icon size={12} className="text-accent-hover" aria-hidden />
            {t(group.label)}
          </h3>
          <ul className="space-y-0.5">
            {SOUNDS.filter((sound) => sound.category === group.category).map((sound) => (
              <li key={sound.id} className="group flex items-center gap-1.5 rounded-control px-1 py-0.5 hover:bg-panel-800">
                <button
                  type="button"
                  data-testid={`library-sound-play-${sound.id}`}
                  aria-label={t(playing === sound.id ? 'sound.stop' : 'sound.play', { name: t(sound.label) })}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-panel-800 text-slate-300 ring-1 ring-panel-600 hover:text-slate-100"
                  disabled={busy !== null && busy !== sound.id}
                  onClick={() => void preview(sound)}
                >
                  {busy === sound.id && playing !== sound.id ? <Loader2 size={11} className="animate-spin" /> : playing === sound.id ? <Pause size={11} /> : <Play size={11} className="ml-px" />}
                </button>
                <button
                  type="button"
                  data-testid={`library-sound-${sound.id}`}
                  aria-describedby={hintId}
                  disabled={busy !== null}
                  className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                  onClick={() => void add(sound)}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{t(sound.label)}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-slate-500">{clock(soundSeconds(sound))}</span>
                  <Plus size={12} className="shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
