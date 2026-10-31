import { useEffect, useState } from 'react';
import { Download, Loader2, ScanFace, Trash2 } from 'lucide-react';
import type { Clip } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { matteEntry, useMattes } from '@renderer/matting/mattes';
import { trackSubject } from '@renderer/edit/reframeRun';
import { DEFAULT_AUTO_FRAME, TIGHTNESS, planAutoFrame, type HeadSample } from '@renderer/edit/autoFrame';
import { applyFollow, removeFollow } from '@renderer/edit/trackApply';

/**
 * "Follow the face", in the inspector's Effects tab: the clip is pushed in a
 * little and panned to keep the person's head where an operator would keep it,
 * for the whole clip, in the frame the project already has.
 *
 * The head comes from the people matte "Remove background" and "Reframe for
 * vertical" already use (the Fast model, MODNet), so nothing new is
 * downloaded - and that download is asked for here, never made unasked. It is
 * a head estimate from the person's silhouette, not a face detector; the card
 * says so rather than letting the name promise more than it does.
 *
 * The keyframes are written through edit/trackApply.ts, the path "Follow an
 * object" uses, so taking it off puts the clip's own position back and either
 * way is one undo step.
 */

type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; detail: string } | { kind: 'noRoom' } | { kind: 'nobody' };

const CHOICES = [
  { id: 'gentle', value: TIGHTNESS.gentle, label: 'autoFrame.gentle' },
  { id: 'standard', value: TIGHTNESS.standard, label: 'autoFrame.standard' },
  { id: 'close', value: TIGHTNESS.close, label: 'autoFrame.close' },
] as const;

export function AutoFrameCard({ clip }: { clip: Clip }): JSX.Element | null {
  const t = useT();
  const assets = useProjectStore((state) => state.assets);
  const status = useMattes((state) => state.status);
  const downloading = useMattes((state) => state.downloading);
  const [tightness, setTightness] = useState<(typeof CHOICES)[number]['id']>('standard');
  const [calm, setCalm] = useState(DEFAULT_AUTO_FRAME.settleSeconds);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    void useMattes.getState().refresh();
  }, []);

  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  // A picture from a file, with a file to analyse: not a title, a caption or sound.
  if (!asset || asset.kind !== 'video' || !asset.sourcePath || clip.title || clip.caption || clip.audioOnly) return null;

  const model = status?.models.find((candidate) => candidate.id === 'fast');
  const modelReady = model?.present === true;
  const native = hasNativeBridge();
  const following = clip.tracking !== undefined;
  const busy = phase.kind === 'running' || downloading !== null;

  const run = async (): Promise<void> => {
    setPhase({ kind: 'running' });
    try {
      const mattes = useMattes.getState();
      const entry = matteEntry(asset.sourcePath!, 'fast');
      if (!(entry in useMattes.getState().urls)) await mattes.lookup(asset.sourcePath!, 'fast');
      if (!useMattes.getState().urls[entry]) await mattes.analyse(asset, 'fast');
      const url = useMattes.getState().urls[entry];
      if (!url) throw new Error(useMattes.getState().errors[entry] ?? t('autoFrame.noMatte', { name: asset.name }));

      const store = useProjectStore.getState();
      const current = store.project.clips[clip.id];
      if (!current) return;
      const tracked = await trackSubject(url, current, store.project.fps);
      const samples: HeadSample[] = tracked.map((sample) => ({ t: sample.t, x: sample.headX, y: sample.headY }));
      if (!samples.some((sample) => sample.x !== null)) {
        setPhase({ kind: 'nobody' });
        return;
      }
      // Said, not swallowed: a follow that frames badly is almost always a head
      // the matte put somewhere else, and this is the only way to tell from outside.
      const found = samples.filter((sample) => sample.x !== null);
      const place = (sample: HeadSample): string => `${sample.t.toFixed(1)}s (${sample.x?.toFixed(2)}, ${sample.y?.toFixed(2)})`;
      console.info(`[autoframe] ${found.length}/${samples.length} samples found a head, from ${place(found[0])} to ${place(found[found.length - 1])}`);
      const chosen = CHOICES.find((candidate) => candidate.id === tightness) ?? CHOICES[1];
      const plan = planAutoFrame(store.project, current, asset, samples, { ...DEFAULT_AUTO_FRAME, tightness: chosen.value, settleSeconds: calm });
      if (!plan) {
        setPhase({ kind: 'noRoom' });
        return;
      }
      applyFollow(clip.id, plan.position, current.startFrame, plan.scale);
      setPhase({ kind: 'idle' });
      notify(t('autoFrame.done', { percent: Math.round(plan.shot.width * 100) }), 'success');
    } catch (error) {
      setPhase({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div data-testid="clip-fx-auto-frame" className="rounded-panel border border-panel-700 bg-panel-900/60 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <ScanFace size={13} aria-hidden className="shrink-0 text-slate-400" />
        <h4 className="text-xs font-medium text-slate-200">{t('autoFrame.title')}</h4>
      </div>
      <p className="mb-2 text-2xs leading-relaxed text-slate-400">{t('autoFrame.hint')}</p>

      <div role="radiogroup" aria-label={t('autoFrame.tightness')} className="mb-2 grid grid-cols-3 gap-1">
        {CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={tightness === choice.id}
            data-testid={`clip-fx-auto-frame-${choice.id}`}
            disabled={busy}
            className={`tool-button tool-button-dense h-6 rounded-control text-2xs ${tightness === choice.id ? 'tool-button-active ring-1 ring-accent' : 'border border-panel-700'}`}
            onClick={() => setTightness(choice.id)}
          >
            {t(choice.label)}
          </button>
        ))}
      </div>

      <label className="mb-2 flex items-center gap-2 text-2xs text-slate-300">
        <span className="shrink-0">{t('autoFrame.calm')}</span>
        <input
          type="range"
          data-testid="clip-fx-auto-frame-calm"
          min={0.2}
          max={2}
          step={0.1}
          value={calm}
          disabled={busy}
          aria-label={t('autoFrame.calm')}
          className="min-w-0 flex-1"
          onChange={(event) => setCalm(Number(event.target.value))}
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-slate-400">{calm.toFixed(1)} s</span>
      </label>

      {model && !modelReady && (
        <button
          type="button"
          data-testid="clip-fx-auto-frame-download"
          className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-control border border-panel-700 px-2 py-1 text-2xs text-slate-200"
          disabled={downloading !== null || !native}
          onClick={() => void useMattes.getState().download('fast')}
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {downloading ? `${Math.round((downloading.received / Math.max(1, downloading.total)) * 100)} %` : t('autoFrame.download', { size: Math.round((model.bytes ?? 0) / 1048576) })}
        </button>
      )}

      <div className="flex gap-1">
        <button
          type="button"
          data-testid="clip-fx-auto-frame-run"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-control bg-accent px-2 py-1 text-2xs font-medium text-panel-950 disabled:opacity-50"
          disabled={busy || !native || !modelReady}
          onClick={() => void run()}
        >
          {phase.kind === 'running' ? <Loader2 size={13} className="animate-spin" /> : <ScanFace size={13} />}
          {phase.kind === 'running' ? t('autoFrame.working') : t(following ? 'autoFrame.again' : 'autoFrame.run')}
        </button>
        {following && (
          <button
            type="button"
            data-testid="clip-fx-auto-frame-remove"
            aria-label={t('autoFrame.remove')}
            title={t('autoFrame.remove')}
            className="tool-button tool-button-dense h-auto rounded-control border border-panel-700 px-2"
            disabled={busy}
            onClick={() => removeFollow(clip.id)}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {phase.kind === 'failed' && <p data-testid="clip-fx-auto-frame-failed" className="mt-1.5 text-2xs text-rose-300">{phase.detail}</p>}
      {phase.kind === 'noRoom' && <p data-testid="clip-fx-auto-frame-no-room" className="mt-1.5 text-2xs text-amber-300">{t('autoFrame.noRoom')}</p>}
      {phase.kind === 'nobody' && <p data-testid="clip-fx-auto-frame-nobody" className="mt-1.5 text-2xs text-amber-300">{t('autoFrame.nobody')}</p>}
    </div>
  );
}
