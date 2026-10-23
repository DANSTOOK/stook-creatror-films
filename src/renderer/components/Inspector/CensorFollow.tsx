import { useState } from 'react';
import { Loader2, ScanEye } from 'lucide-react';
import type { Clip, ClipEffect, Keyframe } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { canTrackIn, followerKeyframes, followerScaleKeyframes, trackRequest } from '@renderer/edit/track';
import { useTrackEditStore } from '@renderer/edit/trackEdit';
import { effectValuesAt } from '@renderer/fx/effects/catalog';
import { createId } from '@shared/utils/id';

/**
 * The hidden area following what it hides: a face walking, a car driving
 * past. Mark the thing with a box in the viewer - it starts as the area - and
 * the clip's own footage is followed from the playhead to the clip's end
 * (main/media/trackJob.ts, as "Follow an object" does), and the area is given
 * keyframes: its centre where the thing goes, its size as the thing grows and
 * shrinks. Keyframes before the playhead are kept; following again from
 * another frame replaces the path from there on.
 */

type Status = 'idle' | 'running' | 'failed' | 'outside';

export function CensorFollow({ clip, effect, onChange }: { clip: Clip; effect: ClipEffect; onChange(next: ClipEffect): void }): JSX.Element | null {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const asset = useProjectStore((state) => state.assets.find((candidate) => candidate.uri === clip.sourceUri));
  const purpose = `censor:${effect.id}`;
  const marking = useTrackEditStore((state) => state.clipId === clip.id && state.purpose === purpose);
  const [status, setStatus] = useState<Status>('idle');
  if (!hasNativeBridge() || !canTrackIn(clip, asset)) return null;

  const frame = project.currentFrame;
  const end = clip.startFrame + clip.durationFrames - 1;

  const mark = (): void => {
    if (marking) {
      useTrackEditStore.getState().stop();
      return;
    }
    const values = effectValuesAt(effect, Math.max(clip.startFrame, Math.min(frame, end)));
    setStatus('idle');
    useTrackEditStore.getState().start(clip.id, { x: values.centerX, y: values.centerY, width: values.width, height: values.height }, purpose);
  };

  const follow = async (): Promise<void> => {
    if (!asset?.sourcePath || frame < clip.startFrame || frame >= end) {
      setStatus('outside');
      return;
    }
    setStatus('running');
    try {
      const box = useTrackEditStore.getState().box;
      const samples = await window.filmora.trackObject(asset.sourcePath, trackRequest(clip, asset, box, frame, end, project));
      const now = useProjectStore.getState().project;
      const current = now.clips[clip.id];
      if (!current) return;
      const at = followerKeyframes(samples, current, { x: box.x * now.width, y: box.y * now.height }, frame, end, now);
      const sizes = followerScaleKeyframes(samples, current, { x: box.width, y: box.height }, frame, end, now.fps);
      const track = (values: Array<{ frame: number; value: number }>): Keyframe<number>[] =>
        values.map(({ frame: at, value }) => ({ id: createId('kf'), frame: at, value, easing: 'linear' as const }));
      // What came before the playhead stays; the path from here is the new one.
      const before = (name: string): Keyframe<number>[] => (effect.keyframes?.[name] ?? []).filter((key) => key.frame < frame);
      onChange({
        ...effect,
        params: { ...effect.params, centerX: box.x, centerY: box.y, width: box.width, height: box.height },
        keyframes: {
          ...effect.keyframes,
          centerX: [...before('centerX'), ...track(at.map((key) => ({ frame: key.frame, value: key.value.x / now.width })))],
          centerY: [...before('centerY'), ...track(at.map((key) => ({ frame: key.frame, value: key.value.y / now.height })))],
          width: [...before('width'), ...track(sizes.length > 0 ? sizes.map((key) => ({ frame: key.frame, value: key.value.x })) : [{ frame, value: box.width }])],
          height: [...before('height'), ...track(sizes.length > 0 ? sizes.map((key) => ({ frame: key.frame, value: key.value.y })) : [{ frame, value: box.height }])],
        },
      });
      useTrackEditStore.getState().stop();
      setStatus('idle');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-panel-700 bg-panel-950/50 p-2" data-testid="censor-follow">
      <div className="flex flex-wrap items-center gap-1.5">
        <ScanEye size={13} aria-hidden className="text-emerald-400" />
        <button
          type="button"
          data-testid="censor-follow-mark"
          aria-pressed={marking}
          disabled={status === 'running'}
          className={`tool-button tool-button-dense h-7 border px-2 text-2xs ${marking ? 'tool-button-active border-emerald-500/60' : 'border-panel-600'}`}
          onClick={mark}
        >
          {marking ? t('censor.markDone') : t('censor.mark')}
        </button>
        {marking && (
          <button
            type="button"
            data-testid="censor-follow-run"
            disabled={status === 'running'}
            className="tool-button tool-button-dense h-7 border border-emerald-500/60 bg-emerald-600/20 px-2 text-2xs text-emerald-200"
            onClick={() => void follow()}
          >
            {status === 'running' && <Loader2 size={12} className="animate-spin" />}
            {t('censor.run')}
          </button>
        )}
      </div>
      <p className="text-2xs leading-relaxed text-slate-400" aria-live="polite" data-testid="censor-follow-hint">
        {status === 'running' ? t('track.running') : status === 'failed' ? t('track.failed') : status === 'outside' ? t('track.outside') : marking ? t('censor.marking') : t('censor.hint')}
      </p>
    </div>
  );
}
