import { useEffect, useState } from 'react';
import { Crop, Download, Loader2 } from 'lucide-react';
import { create } from 'zustand';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { SliderRow } from '@renderer/components/Inspector/rows';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { matteEntry, useMattes } from '@renderer/matting/mattes';
import { reframedSize } from '@renderer/edit/reframe';
import { planReframe, reframeableClips, trackSubject } from '@renderer/edit/reframeRun';

/**
 * "Reframe for vertical": the whole project turned into a vertical (or
 * square, or 4:5) one, each clip filling the new frame and - with Follow the
 * person on - keyframed to keep the person in it (edit/reframe.ts). The
 * person is found with the people matte Remove background uses (the Fast
 * model, MODNet); its download is asked for here, never made unasked.
 */

export const useReframeDialog = create<{ open: boolean; show(): void; close(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

const SHAPES = [
  { id: 'vertical', aspect: { w: 9, h: 16 }, label: 'reframe.vertical' },
  { id: 'square', aspect: { w: 1, h: 1 }, label: 'reframe.square' },
  { id: 'portrait', aspect: { w: 4, h: 5 }, label: 'reframe.portrait' },
] as const;

type Phase = { kind: 'idle' } | { kind: 'analysing'; done: number; total: number; name: string } | { kind: 'failed'; detail: string };

export function ReframeDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const status = useMattes((state) => state.status);
  const downloading = useMattes((state) => state.downloading);
  const jobs = useMattes((state) => state.jobs);
  const [shape, setShape] = useState<(typeof SHAPES)[number]['id']>('vertical');
  const [follow, setFollow] = useState(true);
  const [calm, setCalm] = useState(0.9);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    void useMattes.getState().refresh();
  }, []);

  const chosen = SHAPES.find((candidate) => candidate.id === shape) ?? SHAPES[0];
  const size = reframedSize(project.width, project.height, chosen.aspect);
  const clips = reframeableClips(project, assets);
  const videos = clips.filter(({ asset }) => asset.kind === 'video' && asset.sourcePath);
  const model = status?.models.find((candidate) => candidate.id === 'fast');
  const modelReady = model?.present === true;
  const native = hasNativeBridge();
  const canFollow = follow && native && status?.available !== false;
  const busy = phase.kind === 'analysing' || downloading !== null;

  const run = async (): Promise<void> => {
    const subjects = new Map<string, Array<{ t: number; x: number | null }>>();
    if (canFollow && videos.length > 0) {
      const mattes = useMattes.getState();
      // Each file once: analysed if it has no people matte yet, then read clip by clip.
      const files = [...new Map(videos.map(({ asset }) => [asset.sourcePath!, asset])).values()];
      try {
        for (const [index, asset] of files.entries()) {
          setPhase({ kind: 'analysing', done: index, total: files.length, name: asset.name });
          const entry = matteEntry(asset.sourcePath!, 'fast');
          if (!(entry in useMattes.getState().urls)) await mattes.lookup(asset.sourcePath!, 'fast');
          if (!useMattes.getState().urls[entry]) await mattes.analyse(asset, 'fast');
          const url = useMattes.getState().urls[entry];
          const error = useMattes.getState().errors[entry];
          if (!url) throw new Error(error ?? t('reframe.noMatte', { name: asset.name }));
          for (const { clip } of videos.filter((item) => item.asset.sourcePath === asset.sourcePath)) {
            subjects.set(clip.id, await trackSubject(url, clip, project.fps));
          }
        }
      } catch (error) {
        setPhase({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const plan = planReframe(useProjectStore.getState().project, useProjectStore.getState().assets, chosen.aspect, subjects, { deadZone: 0.15, settleSeconds: calm });
    useProjectStore.getState().reframeProject(plan.size, plan.transforms);
    setPhase({ kind: 'idle' });
    notify(t('reframe.done', { width: plan.size.width, height: plan.size.height, count: subjects.size }), 'success');
    onClose();
  };

  const job = phase.kind === 'analysing' ? Object.values(jobs)[0] : undefined;

  return (
    <Dialog
      title={t('reframe.title')}
      icon={Crop}
      onClose={onClose}
      closing={closing}
      dismissible={!busy}
      testId="reframe-dialog"
      widthClass="w-[500px]"
      bodyClassName="space-y-3 p-4"
      initialFocus="dialog"
      footer={
        <>
          <button type="button" className="tool-button" onClick={onClose} disabled={busy}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="reframe-apply"
            disabled={busy || clips.length === 0 || (canFollow && videos.length > 0 && !modelReady)}
            onClick={() => void run()}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('reframe.apply', { width: size.width, height: size.height })}
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-slate-300">{t('reframe.intro', { width: project.width, height: project.height })}</p>

      <div role="radiogroup" aria-label={t('reframe.shape')} className="grid grid-cols-3 gap-2">
        {SHAPES.map((candidate) => {
          const on = candidate.id === shape;
          const target = reframedSize(project.width, project.height, candidate.aspect);
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`reframe-shape-${candidate.id}`}
              disabled={busy}
              className={`press flex flex-col items-center gap-1.5 rounded-lg border p-2.5 ${on ? 'border-accent/60 bg-accent/15' : 'border-panel-700 bg-panel-900 hover:border-panel-600'}`}
              onClick={() => setShape(candidate.id)}
            >
              <span aria-hidden className="flex h-12 items-center">
                <span className="block rounded-sm border-2 border-slate-300/80" style={{ width: (36 * candidate.aspect.w) / Math.max(candidate.aspect.w, candidate.aspect.h), height: (44 * candidate.aspect.h) / Math.max(candidate.aspect.w, candidate.aspect.h) }} />
              </span>
              <span className="text-xs font-medium text-slate-100">{t(candidate.label)}</span>
              <span className="text-2xs text-slate-400">
                {target.width}x{target.height}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-2 rounded-lg border border-panel-700 bg-panel-900/60 p-3">
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
          {t('reframe.follow')}
          <input type="checkbox" role="switch" data-testid="reframe-follow" checked={follow} disabled={busy} onChange={(event) => setFollow(event.target.checked)} />
        </label>
        <p className="text-2xs leading-relaxed text-slate-400">{follow ? t('reframe.followHint') : t('reframe.centreHint')}</p>
        {follow && (
          <SliderRow label={t('reframe.camera')} value={calm} min={0.4} max={2} step={0.05} format={(value) => (value < 0.75 ? t('reframe.agile') : value > 1.3 ? t('reframe.calm') : t('reframe.balanced'))} onChange={setCalm} />
        )}
        {follow && model && !modelReady && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2" data-testid="reframe-model">
            <p className="text-2xs leading-relaxed text-amber-100">{t('reframe.needsModel', { size: `${Math.round(model.bytes / 1e6)} MB` })}</p>
            <button
              type="button"
              className="tool-button h-control shrink-0 border border-amber-300/50"
              disabled={downloading !== null}
              onClick={() => void useMattes.getState().download('fast')}
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {downloading ? `${Math.round((downloading.received / Math.max(1, downloading.total)) * 100)} %` : t('reframe.download')}
            </button>
          </div>
        )}
      </div>

      <p className="text-2xs leading-relaxed text-slate-400">{t('reframe.replaces', { count: clips.length })}</p>

      {phase.kind === 'analysing' && (
        <p className="text-xs text-slate-200" data-testid="reframe-progress" aria-live="polite">
          {t('reframe.analysing', { index: phase.done + 1, total: phase.total, name: phase.name })}
          {job && job.total > 0 ? ` · ${Math.round((job.done / job.total) * 100)} %` : ''}
        </p>
      )}
      {phase.kind === 'failed' && (
        <p role="alert" className="text-xs text-red-300">
          {t('reframe.failed', { detail: phase.detail })}
        </p>
      )}
    </Dialog>
  );
}
