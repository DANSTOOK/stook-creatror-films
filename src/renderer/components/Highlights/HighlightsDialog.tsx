import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { create } from 'zustand';
import type { Clip } from '@shared/types';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { totalSeconds, type Highlight } from '@renderer/edit/highlights';
import { keepOnlyHighlights, markHighlights, scanHighlights, soundSourceOf } from '@renderer/edit/highlightsRun';

/**
 * Best moments.
 *
 * It offers two things to do with what it found and nothing else: MARK them,
 * which changes nothing and lets a person look; or KEEP ONLY them, which is
 * the edit. Marking is offered first because a machine's opinion of which
 * minute of your recording matters is worth checking before it cuts.
 *
 * The analysis is the app's own - silences and shot changes - so this dialog
 * measures nothing new. What it adds is the judgement, and the panel says in
 * one line what that judgement actually is, because a tool that claims to
 * find "the good bits" without saying how is asking to be trusted blindly.
 */

interface DialogState {
  clipId: string | null;
  open(clipId: string): void;
  close(): void;
}

export const useHighlightsDialog = create<DialogState>((set) => ({
  clipId: null,
  open: (clipId) => set({ clipId }),
  close: () => set({ clipId: null }),
}));

type Status =
  | { kind: 'idle' }
  | { kind: 'looking' }
  | { kind: 'found'; highlights: Highlight[] }
  | { kind: 'failed' }
  | { kind: 'none' };

const COUNTS = [3, 5, 8, 12];

export function HighlightsDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element | null {
  const t = useT();
  const clipId = useHighlightsDialog((state) => state.clipId);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const clips = useProjectStore((state) => state.project.clips);
  const assets = useProjectStore((state) => state.assets);
  const fps = useProjectStore((state) => state.project.fps);

  const [count, setCount] = useState(5);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const run = useRef(0);

  const path = clip ? soundSourceOf(clip, clips, assets) : null;

  useEffect(() => {
    if (!clip || !path) {
      setStatus({ kind: 'idle' });
      return;
    }
    const ticket = (run.current += 1);
    setStatus({ kind: 'looking' });
    void scanHighlights(clip, path, fps, { count, minSeconds: 6, maxSeconds: 60 })
      .then((found) => {
        if (run.current !== ticket) return;
        if (!found) setStatus({ kind: 'failed' });
        else setStatus(found.highlights.length === 0 ? { kind: 'none' } : { kind: 'found', highlights: found.highlights });
      })
      .catch(() => {
        if (run.current === ticket) setStatus({ kind: 'failed' });
      });
  }, [clip, path, fps, count]);

  if (!clipId || !clip) return null;

  const highlights = status.kind === 'found' ? status.highlights : [];
  const clock = (seconds: number): string => {
    const whole = Math.max(0, Math.round(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };

  const mark = (): void => {
    const made = markHighlights(clip, highlights, fps, (index) => t('highlights.marker', { n: index }));
    notify(t('highlights.marked', { count: made }), 'success');
    onClose();
  };

  const keep = (): void => {
    const removed = keepOnlyHighlights(clip, highlights, fps);
    notify(t('highlights.kept', { count: highlights.length, seconds: Math.round(removed / fps) }), 'success');
    onClose();
  };

  return (
    <Dialog
      title={t('highlights.title')}
      icon={Sparkles}
      onClose={onClose}
      closing={closing}
      testId="highlights-dialog"
      widthClass="w-[520px]"
      bodyClassName="space-y-3 p-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="tool-button h-control border border-panel-600 px-3" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          {/* Marking first: it changes nothing, and a machine's opinion of
              which minute matters is worth looking at before it cuts. */}
          <button
            type="button"
            data-testid="highlights-mark"
            className="tool-button h-control border border-panel-600 px-3"
            disabled={highlights.length === 0}
            onClick={mark}
          >
            {t('highlights.mark')}
          </button>
          <button type="button" data-testid="highlights-keep" className="button-primary h-control px-4" disabled={highlights.length === 0} onClick={keep}>
            {t('highlights.keep')}
          </button>
        </div>
      }
    >
      <p className="text-2xs leading-relaxed text-slate-400">{t('highlights.how')}</p>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <span className="w-28 shrink-0">{t('highlights.count')}</span>
        <select
          data-testid="highlights-count"
          value={count}
          onChange={(event) => setCount(Number(event.target.value))}
          className="input-field h-control flex-1 px-2"
        >
          {COUNTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {status.kind === 'looking' && (
        <p data-testid="highlights-looking" className="text-xs text-slate-400">
          {t('highlights.looking')}
        </p>
      )}
      {status.kind === 'failed' && (
        <p data-testid="highlights-failed" className="text-xs text-amber-300">
          {t('highlights.failed')}
        </p>
      )}
      {status.kind === 'none' && (
        <p data-testid="highlights-none" className="text-xs text-amber-300">
          {t('highlights.none')}
        </p>
      )}
      {!path && clip && (
        <p data-testid="highlights-nosound" className="text-xs text-amber-300">
          {t('highlights.noSound')}
        </p>
      )}

      {highlights.length > 0 && (
        <>
          <ol data-testid="highlights-list" className="max-h-56 space-y-1 overflow-y-auto">
            {highlights.map((one, index) => (
              <li key={`${one.start}-${index}`} className="flex items-center gap-2 rounded-control bg-panel-900 px-2 py-1.5 ring-1 ring-panel-700">
                <span className="w-5 shrink-0 text-center text-2xs tabular-nums text-slate-500">{index + 1}</span>
                <span className="shrink-0 text-2xs tabular-nums text-slate-300">
                  {clock(one.start)} – {clock(one.end)}
                </span>
                {/* The bar is the score, which is simply how long the talking
                    runs. Shown rather than hidden, so it can be disagreed with. */}
                <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(one.score * 100)}%` }} />
                </span>
                <span className="shrink-0 text-2xs tabular-nums text-slate-500">{Math.round(one.speaking)}s</span>
              </li>
            ))}
          </ol>
          <p data-testid="highlights-total" className="text-2xs text-slate-400">
            {t('highlights.total', { count: highlights.length, seconds: Math.round(totalSeconds(highlights)), whole: Math.round(clip.durationFrames / fps) })}
          </p>
        </>
      )}
    </Dialog>
  );
}

/** Whether this clip can be looked at: it needs sound to find talking in. */
export const canFindHighlights = (clip: Clip | undefined, clips: Record<string, Clip>, assets: readonly { uri: string; audioUri?: string; sourcePath?: string }[]): boolean =>
  Boolean(clip && soundSourceOf(clip, clips, assets as never));
