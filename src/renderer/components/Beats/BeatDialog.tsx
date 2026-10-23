import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Music2 } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';
import { clipSourceSeconds } from '@renderer/edit/silences';
import { beatTimelineFrames, type BeatEvery } from '@renderer/edit/beats';

/**
 * Cut to the music: the beats of a music clip found (main/media/beats.ts),
 * its tempo shown, and every beat - or every second one, or each bar - put
 * on the timeline as markers to cut to by hand, or the pictures above cut
 * there at once, a shot a beat. One undo step either way.
 */

export const useBeatDialog = create<{ open: boolean; clipId: string | null; show(clipId: string): void; close(): void }>((set) => ({
  open: false,
  clipId: null,
  show: (clipId) => set({ open: true, clipId }),
  close: () => set({ open: false }),
}));

type Status = { kind: 'looking' } | { kind: 'found'; bpm: number; beats: number[]; downbeats: number[] } | { kind: 'failed' };

const EVERY: BeatEvery[] = [1, 2, 4];
const EVERY_LABEL: Record<BeatEvery, 'beats.every1' | 'beats.every2' | 'beats.every4'> = { 1: 'beats.every1', 2: 'beats.every2', 4: 'beats.every4' };

export function BeatDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element {
  const t = useT();
  const clipId = useBeatDialog((state) => state.clipId);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const assets = useProjectStore((state) => state.assets);
  const fps = useProjectStore((state) => state.project.fps);
  const asset = useMemo(() => (clip ? assets.find((candidate) => candidate.uri === clip.sourceUri) : undefined), [clip, assets]);
  const [status, setStatus] = useState<Status>({ kind: 'looking' });
  const [every, setEvery] = useState<BeatEvery>(1);

  useEffect(() => {
    if (!clip || !asset?.sourcePath) {
      setStatus({ kind: 'failed' });
      return undefined;
    }
    let cancelled = false;
    setStatus({ kind: 'looking' });
    const span = clipSourceSeconds(clip, fps);
    window.filmora
      .detectBeats(asset.sourcePath, span.from, span.to)
      .then((found) => {
        if (!cancelled) setStatus(found.beats.length > 0 ? { kind: 'found', ...found } : { kind: 'failed' });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
    // Found once a clip: its own edits while the dialog is open do not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, asset?.sourcePath, fps]);

  const frames = status.kind === 'found' && clip ? beatTimelineFrames(clip, status.beats, status.downbeats, every, fps) : [];

  const mark = (): void => {
    const added = useProjectStore.getState().addBeatMarkers(frames, true);
    notify(t('beats.marked', { count: added }), 'success');
    onClose();
  };
  const cut = (): void => {
    if (!clip) return;
    const cuts = useProjectStore.getState().cutAtBeats(frames, clip.trackId);
    notify(cuts > 0 ? t('beats.cut', { count: cuts }) : t('beats.nothingToCut'), cuts > 0 ? 'success' : 'info');
    onClose();
  };

  return (
    <Dialog
      title={t('beats.title')}
      icon={Music2}
      onClose={onClose}
      closing={closing}
      testId="beat-dialog"
      widthClass="w-[440px]"
      bodyClassName="space-y-3 p-4"
      footer={
        <>
          <button type="button" data-testid="beat-mark" className="tool-button h-control border border-panel-600" disabled={frames.length === 0} onClick={mark}>
            {t('beats.markButton')}
          </button>
          <button type="button" data-testid="beat-cut" className="button-primary" disabled={frames.length === 0} onClick={cut}>
            {t('beats.cutButton')}
          </button>
        </>
      }
    >
      <p className="text-2xs leading-relaxed text-slate-400">{t('beats.hint')}</p>
      <div data-testid="beat-status" className="rounded-lg border border-panel-700 bg-panel-950/60 p-3 text-center">
        {status.kind === 'looking' ? (
          <span className="text-xs text-slate-300">{t('beats.looking')}</span>
        ) : status.kind === 'failed' ? (
          <span className="text-xs text-amber-300">{t('beats.failed')}</span>
        ) : (
          <>
            <span className="block text-2xl font-semibold tabular-nums text-slate-100" data-testid="beat-bpm">
              {Math.round(status.bpm)} BPM
            </span>
            <span className="text-2xs text-slate-400" data-testid="beat-count">
              {t('beats.count', { count: frames.length })}
            </span>
          </>
        )}
      </div>
      <div role="radiogroup" aria-label={t('beats.everyLabel')} className="grid grid-cols-3 gap-1 rounded-control bg-panel-950 p-0.5">
        {EVERY.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={every === option}
            data-testid={`beat-every-${option}`}
            className={`rounded-[4px] py-1 text-2xs ${every === option ? 'bg-panel-700 font-medium text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
            onClick={() => setEvery(option)}
          >
            {t(EVERY_LABEL[option])}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
