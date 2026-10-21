import { useEffect, useMemo, useRef, useState } from 'react';
import { Scissors } from 'lucide-react';
import type { Clip, MediaAsset } from '@shared/types';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { SliderRow } from '@renderer/components/Inspector/rows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { pairedClip } from '@renderer/components/Timeline/detachAudio';
import { useSilenceDialogStore } from '@renderer/edit/silenceDialog';
import { canRemoveSilences, clipSourceSeconds, silenceRanges, type FrameRange } from '@renderer/edit/silences';

/**
 * "Remove silences": find where a clip's sound goes quiet, show it along the
 * clip, and take it out - a jump cut, the way creators trim talking-head
 * footage. The three settings are the ones every such tool has: how quiet
 * counts as silence, how long a pause has to be, and how much quiet to keep
 * either side so words are not clipped. Each change looks again (it takes a
 * moment of ffmpeg); nothing is cut until "Remove".
 */

/** The file a clip's sound is in: its own, or for a picture whose sound was detached, its sound's. */
function soundSource(clip: Clip, clips: Record<string, Clip>, assets: readonly MediaAsset[]): { clip: Clip; path: string } | null {
  const owner = clip.audioDetached ? pairedClip(clips, clip.id) ?? clip : clip;
  const asset = assets.find((candidate) => candidate.uri === owner.sourceUri || candidate.audioUri === owner.sourceUri);
  return asset?.sourcePath ? { clip: owner, path: asset.sourcePath } : null;
}

type Status = { kind: 'looking' } | { kind: 'found'; ranges: FrameRange[] } | { kind: 'failed' };

export function RemoveSilencesDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element | null {
  const t = useT();
  const clipId = useSilenceDialogStore((state) => state.clipId);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const clips = useProjectStore((state) => state.project.clips);
  const assets = useProjectStore((state) => state.assets);
  const fps = useProjectStore((state) => state.project.fps);
  const [noiseDb, setNoiseDb] = useState(-38);
  const [minSeconds, setMinSeconds] = useState(0.5);
  const [padSeconds, setPadSeconds] = useState(0.12);
  const [status, setStatus] = useState<Status>({ kind: 'looking' });
  const asked = useRef(0);

  const source = useMemo(() => (clip ? soundSource(clip, clips, assets) : null), [clip, clips, assets]);
  const usable = Boolean(clip && source && canRemoveSilences(clip) && hasNativeBridge());

  // Look again whenever a setting settles, a moment after the last change.
  useEffect(() => {
    if (!clip || !source || !usable) return undefined;
    const ask = ++asked.current;
    setStatus({ kind: 'looking' });
    const timer = window.setTimeout(() => {
      const span = clipSourceSeconds(source.clip, fps);
      window.filmora
        .detectSilences(source.path, { noiseDb, minSeconds, fromSeconds: span.from, toSeconds: span.to })
        .then((silences) => {
          if (ask !== asked.current) return;
          // In the frames of the sound's own clip: the cut is made there, and on what is linked to it at the same frames.
          setStatus({ kind: 'found', ranges: silenceRanges(source.clip, silences, fps, padSeconds) });
        })
        .catch(() => {
          if (ask === asked.current) setStatus({ kind: 'failed' });
        });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [clip, source, usable, fps, noiseDb, minSeconds, padSeconds]);

  if (!clip) return null;
  const cutClip = source?.clip ?? clip;
  const ranges = status.kind === 'found' ? status.ranges : [];
  const removedFrames = ranges.reduce((sum, range) => sum + range.to - range.from, 0);
  const seconds = (frames: number): string => (frames / fps).toFixed(1);

  const apply = (): void => {
    if (ranges.length === 0) return;
    const removed = useProjectStore.getState().removeClipRanges(cutClip.id, ranges);
    notify(t('silence.done', { count: ranges.length, seconds: seconds(removed) }), 'success');
    onClose();
  };

  return (
    <Dialog
      title={t('silence.title')}
      icon={Scissors}
      onClose={onClose}
      closing={closing}
      testId="silence-dialog"
      widthClass="w-[480px]"
      bodyClassName="space-y-3 p-4"
      initialFocus="dialog"
      footer={
        <>
          <button type="button" className="tool-button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="button-primary" data-testid="silence-apply" disabled={!usable || ranges.length === 0} onClick={apply}>
            {ranges.length > 0 ? t('silence.apply', { count: ranges.length }) : t('silence.applyNone')}
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-slate-300">{t('silence.intro', { name: clip.name })}</p>

      {!usable ? (
        <p className="rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-100" data-testid="silence-unusable">
          {t('silence.unusable')}
        </p>
      ) : (
        <>
          <div className="space-y-2 rounded-lg border border-panel-700 bg-panel-900/60 p-3">
            <SliderRow label={t('silence.level')} value={noiseDb} min={-60} max={-20} step={1} format={(value) => `${Math.round(value)} dB`} onChange={setNoiseDb} />
            <SliderRow label={t('silence.minimum')} value={minSeconds} min={0.2} max={3} step={0.05} format={(value) => `${value.toFixed(2)} s`} onChange={setMinSeconds} />
            <SliderRow label={t('silence.keep')} value={padSeconds} min={0} max={0.5} step={0.01} format={(value) => `${value.toFixed(2)} s`} onChange={setPadSeconds} />
            <p className="text-2xs leading-relaxed text-slate-400">{t('silence.settingsHint')}</p>
          </div>

          {/* The clip, with what would come out of it marked. */}
          <div>
            <div data-testid="silence-preview" className="relative h-9 overflow-hidden rounded-md bg-emerald-500/25 ring-1 ring-panel-600" aria-hidden>
              {ranges.map((range) => (
                <span
                  key={`${range.from}-${range.to}`}
                  className="absolute inset-y-0 bg-red-500/85"
                  style={{
                    left: `${((range.from - cutClip.startFrame) / cutClip.durationFrames) * 100}%`,
                    width: `${Math.max(0.4, ((range.to - range.from) / cutClip.durationFrames) * 100)}%`,
                    backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.18) 0 3px, transparent 3px 7px)',
                  }}
                />
              ))}
            </div>
            <p className="mt-1.5 flex items-center justify-between text-2xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-sm bg-emerald-500/60" /> {t('silence.legendKept')}
                <span aria-hidden className="ml-2 h-2 w-2 rounded-sm bg-red-500/85" /> {t('silence.legendRemoved')}
              </span>
            </p>
          </div>

          <p data-testid="silence-status" aria-live="polite" className="text-xs text-slate-200">
            {status.kind === 'looking'
              ? t('silence.looking')
              : status.kind === 'failed'
                ? t('silence.failed')
                : ranges.length === 0
                  ? t('silence.none')
                  : t('silence.found', { count: ranges.length, seconds: seconds(removedFrames), total: seconds(cutClip.durationFrames) })}
          </p>
        </>
      )}
    </Dialog>
  );
}
