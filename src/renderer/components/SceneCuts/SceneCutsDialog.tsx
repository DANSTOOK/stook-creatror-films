import { useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { create } from 'zustand';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { SliderRow } from '@renderer/components/Inspector/rows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { isReversed } from '@renderer/timing/clipSpeed';
import { clipSourceSeconds } from '@renderer/edit/silences';
import { sceneCutFrames } from '@renderer/edit/scenes';

/**
 * "Split at scene changes": find where a clip's picture changes shot, show
 * the cuts along it, and cut it there - one clip a take. How sensitive is the
 * one setting: lower finds only hard cuts, higher also finds quick changes
 * of light or framing. Each change looks again; nothing is cut until "Split".
 */

export const useSceneDialog = create<{ open: boolean; clipId: string | null; show(clipId: string): void; close(): void }>((set) => ({
  open: false,
  clipId: null,
  show: (clipId) => set({ open: true, clipId }),
  close: () => set({ open: false }),
}));

/** Sensitivity 0..1 to ffmpeg's scene threshold: 0.6 (hard cuts only) down to 0.1. */
const thresholdFor = (sensitivity: number): number => 0.6 - 0.5 * sensitivity;

type Status = { kind: 'looking' } | { kind: 'found'; frames: number[] } | { kind: 'failed' };

export function SceneCutsDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element | null {
  const t = useT();
  const clipId = useSceneDialog((state) => state.clipId);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const assets = useProjectStore((state) => state.assets);
  const fps = useProjectStore((state) => state.project.fps);
  const [sensitivity, setSensitivity] = useState(0.6);
  const [status, setStatus] = useState<Status>({ kind: 'looking' });
  const asked = useRef(0);

  const asset = useMemo(() => (clip ? assets.find((candidate) => candidate.uri === clip.sourceUri) : undefined), [clip, assets]);
  const usable = Boolean(clip && asset?.kind === 'video' && asset.sourcePath && !isReversed(clip) && hasNativeBridge());

  useEffect(() => {
    if (!clip || !asset?.sourcePath || !usable) return undefined;
    const ask = ++asked.current;
    setStatus({ kind: 'looking' });
    const timer = window.setTimeout(() => {
      const span = clipSourceSeconds(clip, fps);
      window.filmora
        .detectScenes(asset.sourcePath!, { threshold: thresholdFor(sensitivity), fromSeconds: span.from, toSeconds: span.to })
        .then((cuts) => {
          if (ask === asked.current) setStatus({ kind: 'found', frames: sceneCutFrames(clip, cuts, fps) });
        })
        .catch(() => {
          if (ask === asked.current) setStatus({ kind: 'failed' });
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [clip, asset, usable, fps, sensitivity]);

  if (!clip) return null;
  const frames = status.kind === 'found' ? status.frames : [];

  const apply = (): void => {
    if (frames.length === 0) return;
    const pieces = useProjectStore.getState().splitClipAtFrames(clip.id, frames);
    notify(t('scenes.done', { count: pieces }), 'success');
    onClose();
  };

  return (
    <Dialog
      title={t('scenes.title')}
      icon={Clapperboard}
      onClose={onClose}
      closing={closing}
      testId="scene-dialog"
      widthClass="w-[480px]"
      bodyClassName="space-y-3 p-4"
      initialFocus="dialog"
      footer={
        <>
          <button type="button" className="tool-button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="button-primary" data-testid="scene-apply" disabled={!usable || frames.length === 0} onClick={apply}>
            {frames.length > 0 ? t('scenes.apply', { count: frames.length + 1 }) : t('scenes.applyNone')}
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-slate-300">{t('scenes.intro', { name: clip.name })}</p>
      {!usable ? (
        <p className="rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-100" data-testid="scene-unusable">
          {t('scenes.unusable')}
        </p>
      ) : (
        <>
          <div className="space-y-2 rounded-lg border border-panel-700 bg-panel-900/60 p-3">
            <SliderRow
              label={t('scenes.sensitivity')}
              value={sensitivity}
              min={0}
              max={1}
              step={0.05}
              format={(value) => (value < 0.35 ? t('scenes.low') : value > 0.75 ? t('scenes.high') : t('scenes.medium'))}
              onChange={setSensitivity}
            />
            <p className="text-2xs leading-relaxed text-slate-400">{t('scenes.hint')}</p>
          </div>
          {/* The clip, with a mark at each change of shot. */}
          <div data-testid="scene-preview" className="relative h-9 overflow-hidden rounded-md bg-sky-500/20 ring-1 ring-panel-600" aria-hidden>
            {frames.map((frame) => (
              <span key={frame} className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-amber-300" style={{ left: `${((frame - clip.startFrame) / clip.durationFrames) * 100}%` }} />
            ))}
          </div>
          <p data-testid="scene-status" aria-live="polite" className="text-xs text-slate-200">
            {status.kind === 'looking'
              ? t('scenes.looking')
              : status.kind === 'failed'
                ? t('scenes.failed')
                : frames.length === 0
                  ? t('scenes.none')
                  : t('scenes.found', { count: frames.length, pieces: frames.length + 1 })}
          </p>
        </>
      )}
    </Dialog>
  );
}
