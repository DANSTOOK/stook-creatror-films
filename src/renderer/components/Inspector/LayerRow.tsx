import { ArrowUpToLine, EyeOff, Layers } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import { clipLayer, coveringClip, frameToJudge } from '@renderer/components/Timeline/layers';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Which layer the selection is on, under the inspector's header.
 *
 * Every editor stacks pictures the same way - higher tracks cover lower ones,
 * Video 1 at the bottom - but none of that is written anywhere on screen, and
 * a title put on Video 1 under a video on Video 2 is simply not there, with
 * nothing to say why. This says where the clip sits ("Video 1 · under Video
 * 2") and, when something above hides it where the playhead is, what and on
 * which track, with the one-click way out: move it above.
 *
 * Final Cut answers the same question by connecting a title above the
 * picture; Premiere and Resolve leave it to the track numbers.
 *
 * With several clips selected it says which tracks they are on and how many
 * of them are hidden, and "Move above" lifts those - the case of a run of
 * titles all put on Video 1 under the footage.
 */
export function LayerRow({ project, clipIds }: { project: ProjectState; clipIds: readonly string[] }): JSX.Element | null {
  const t = useT();

  // Picture clips only: sound and captions have no place in the stack.
  const placed = clipIds
    .map((id) => ({ clip: project.clips[id], layer: clipLayer(project, id) }))
    .filter((entry): entry is { clip: NonNullable<typeof entry.clip>; layer: NonNullable<typeof entry.layer> } => Boolean(entry.clip && entry.layer && !entry.clip.caption));
  if (placed.length === 0) return null;

  const hidden = placed
    .map(({ clip, layer }) => ({ clip, layer, cover: coveringClip(project, clip.id, frameToJudge(clip, project.currentFrame)) }))
    .filter((entry) => entry.cover !== null);
  const movable = hidden.filter((entry) => !entry.layer.track.locked);

  let where: string;
  if (placed.length === 1) {
    const { layer } = placed[0];
    const names = { track: layer.track.name, above: layer.above?.name ?? '', below: layer.below?.name ?? '' };
    where =
      layer.layers <= 1
        ? t('layer.only', names)
        : !layer.above
          ? t('layer.top', names)
          : !layer.below
            ? t('layer.bottom', names)
            : t('layer.middle', names);
  } else {
    // Top first, as the timeline lists them.
    const onTracks = new Set(placed.map(({ layer }) => layer.track.id));
    const tracks = timelineRows(project.tracks)
      .filter((track) => onTracks.has(track.id))
      .map((track) => track.name)
      .join(', ');
    where = t('layer.many', { tracks });
  }

  const single = placed.length === 1 ? hidden[0] : undefined;
  const warning = single?.cover
    ? t('layer.hiddenBy', { clip: single.cover.clip.name, track: single.cover.track.name })
    : t('layer.manyHidden', { count: hidden.length, total: placed.length });

  return (
    <div data-testid="inspector-layer" className="flex shrink-0 flex-col gap-1.5 border-b border-panel-800 px-3 py-1.5">
      <p className="flex min-w-0 items-center gap-1.5 text-2xs text-slate-400" data-tooltip={t('layer.hint')}>
        <Layers size={12} aria-hidden className="shrink-0" />
        <span className="sr-only">{t('layer.label')}:</span>
        <span data-testid="inspector-layer-text" className="truncate">
          {where}
        </span>
      </p>
      {hidden.length > 0 && (
        <div
          role="status"
          data-testid="inspector-layer-covered"
          className="flex items-center gap-2 rounded-control bg-amber-400/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-200"
        >
          <EyeOff size={12} aria-hidden className="shrink-0" />
          {/* A locked track keeps its clips: said in words, rather than a
              button that does nothing. */}
          <span className="min-w-0 flex-1">{movable.length > 0 ? warning : `${warning} ${t('layer.locked')}`}</span>
          {movable.length > 0 && (
            <button
              type="button"
              data-testid="inspector-layer-raise"
              className="tool-button tool-button-dense shrink-0 gap-1 border border-panel-600 px-1.5 text-slate-100"
              onClick={() => useProjectStore.getState().moveClipsAbove(movable.map(({ clip }) => clip.id))}
              {...tip(t('layer.moveAbove'), { hint: t('layer.moveAboveHint'), named: false })}
            >
              <ArrowUpToLine size={12} aria-hidden />
              {t('layer.moveAbove')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
