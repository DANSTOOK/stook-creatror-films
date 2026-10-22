import { useState } from 'react';
import { Loader2, ScanEye, Trash2 } from 'lucide-react';
import type { Clip } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { followerKeyframes, followerScaleKeyframes, trackEndFrame, trackRequest, trackTargetFor } from '@renderer/edit/track';
import { applyFollow, followOrigin, followOwnScale, removeFollow } from '@renderer/edit/trackApply';
import { useTrackEditStore } from '@renderer/edit/trackEdit';

/**
 * "Follow an object", in the inspector's Effects tab: mark a thing in the
 * video under this clip with a box in the viewer, and the clip follows it
 * from the playhead to where either clip ends (edit/track.ts). Following
 * again from another frame replaces the path from there on.
 */

type Status = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed' } | { kind: 'outside' };

export function FollowCard({ clip }: { clip: Clip }): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const markingFor = useTrackEditStore((state) => state.clipId);
  const startMarking = useTrackEditStore((state) => state.start);
  const stopMarking = useTrackEditStore((state) => state.stop);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Size too, as CapCut's "position and scale" tracking: on by default; off keeps the clip's own size.
  const [withSize, setWithSize] = useState(true);

  const frame = project.currentFrame;
  const target = hasNativeBridge() ? trackTargetFor(project, assets, clip, frame) : null;
  const marking = markingFor === clip.id;

  const mark = (): void => {
    if (marking) {
      stopMarking();
      return;
    }
    // Start the box where the clip is: what it follows is usually under it.
    const at = followOrigin(clip, Math.max(clip.startFrame, Math.min(frame, clip.startFrame + clip.durationFrames - 1)));
    const width = 0.15;
    const height = Math.min(0.6, (width * project.width) / project.height);
    const x = Math.min(1 - width / 2, Math.max(width / 2, 0.5 + at.x / project.width));
    const y = Math.min(1 - height / 2, Math.max(height / 2, 0.5 + at.y / project.height));
    setStatus({ kind: 'idle' });
    startMarking(clip.id, { x, y, width, height });
  };

  const follow = async (): Promise<void> => {
    if (!target) return;
    const asset = assets.find((candidate) => candidate.uri === target.sourceUri);
    const end = trackEndFrame(target, clip);
    if (!asset?.sourcePath || frame < clip.startFrame || frame >= end) {
      setStatus({ kind: 'outside' });
      return;
    }
    setStatus({ kind: 'running' });
    try {
      const box = useTrackEditStore.getState().box;
      const samples = await window.filmora.trackObject(asset.sourcePath, trackRequest(target, asset, box, frame, end, project));
      // The clips as they are now: the playhead and the box are as they were when Follow was pressed.
      const now = useProjectStore.getState().project;
      const follower = now.clips[clip.id];
      const under = now.clips[target.id];
      if (!follower || !under) return;
      applyFollow(
        clip.id,
        followerKeyframes(samples, under, followOrigin(follower, frame), frame, end, now),
        frame,
        withSize ? followerScaleKeyframes(samples, under, followOwnScale(follower, frame), frame, end, now.fps) : undefined,
      );
      stopMarking();
      setStatus({ kind: 'idle' });
    } catch {
      setStatus({ kind: 'failed' });
    }
  };

  return (
    <section data-testid="clip-fx-follow" className="mx-2 mb-2 rounded-lg border border-panel-700 bg-panel-900/70 p-2.5">
      <header className="mb-2 flex items-center gap-2">
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
          <ScanEye size={13} />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">{t('track.title')}</h3>
        {clip.tracking && (
          <button type="button" data-testid="clip-fx-follow-remove" className="tool-button tool-button-dense gap-1 text-2xs text-slate-400 hover:text-red-400" onClick={() => removeFollow(clip.id)}>
            <Trash2 size={11} />
            {t('track.remove')}
          </button>
        )}
      </header>
      <div className="space-y-2">
        {clip.tracking && (
          <p data-testid="clip-fx-follow-state" className="text-2xs text-emerald-300">
            {t('track.following', { frame: clip.tracking.fromFrame })}
          </p>
        )}
        {!target ? (
          <p className="text-2xs leading-relaxed text-slate-400">{t('track.noTarget')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="clip-fx-follow-mark"
                aria-pressed={marking}
                disabled={status.kind === 'running'}
                className={`tool-button h-control border ${marking ? 'tool-button-active border-emerald-500/60' : 'border-panel-600'}`}
                onClick={mark}
              >
                {marking ? t('track.markDone') : t('track.mark')}
              </button>
              {marking && (
                <label className="flex w-full items-center gap-2 text-2xs text-slate-300">
                  <input
                    type="checkbox"
                    data-testid="clip-fx-follow-size"
                    checked={withSize}
                    disabled={status.kind === 'running'}
                    onChange={(event) => setWithSize(event.target.checked)}
                  />
                  {t('track.withSize')}
                </label>
              )}
              {marking && (
                <button
                  type="button"
                  data-testid="clip-fx-follow-run"
                  disabled={status.kind === 'running'}
                  className="tool-button h-control border border-emerald-500/60 bg-emerald-600/20 text-emerald-200"
                  onClick={() => void follow()}
                >
                  {status.kind === 'running' && <Loader2 size={13} className="animate-spin" />}
                  {t('track.run')}
                </button>
              )}
            </div>
            <p data-testid="clip-fx-follow-hint" className="text-2xs leading-relaxed text-slate-400" aria-live="polite">
              {status.kind === 'running'
                ? t('track.running')
                : status.kind === 'failed'
                  ? t('track.failed')
                  : status.kind === 'outside'
                    ? t('track.outside')
                    : marking
                      ? t('track.marking')
                      : t('track.hint')}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
