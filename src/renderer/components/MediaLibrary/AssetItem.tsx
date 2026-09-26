import { memo, useMemo, type MouseEvent } from 'react';
import { FileVideo, Image as ImageIcon, Link2, Music, Plus, Trash2 } from 'lucide-react';
import type { MediaAsset, MediaKind } from '@shared/types';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { ASSET_DRAG_TYPE } from '@renderer/components/Timeline/dropPlacement';
import { assetLengthSeconds } from '@renderer/media/assetLength';
import { useT } from '@renderer/i18n';

/**
 * One clip in the media panel, as a thumbnail or as a row.
 *
 * Thumbnails are Final Cut's browser and Resolve's Media Pool thumbnail view:
 * a picture big enough to recognise a shot by, its length on it, the name
 * under it. The list is for names and formats. In both, the actions a
 * pointer offers (add at the playhead, remove) float over the picture's
 * corner instead of taking room from the name - they used to push it along.
 */

export type MediaView = 'grid' | 'list';

export const MEDIA_VIEW_KEY = 'scf.mediaView';

export function loadMediaView(): MediaView {
  try {
    return window.localStorage.getItem(MEDIA_VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function saveMediaView(view: MediaView): void {
  try {
    window.localStorage.setItem(MEDIA_VIEW_KEY, view);
  } catch {
    // Remembered for this session only.
  }
}

const KIND_ICONS: Record<MediaKind, typeof FileVideo> = {
  video: FileVideo,
  audio: Music,
  image: ImageIcon,
};

/** "0:20", "12:05", "1:02:07": a clip's length as editors print it on a thumbnail. */
export function durationBadge(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** A sound's thumbnail: its waveform in 40 bars, from the peaks the timeline draws. */
function MiniWave({ peaks }: { peaks: WaveformPeaks }): JSX.Element {
  const bars = useMemo(() => {
    const count = 40;
    const out: number[] = [];
    const per = Math.max(1, Math.floor(peaks.bucketCount / count));
    for (let bar = 0; bar < count; bar += 1) {
      let level = 0;
      for (let bucket = bar * per; bucket < Math.min(peaks.bucketCount, (bar + 1) * per); bucket += 1) {
        level = Math.max(level, Math.abs(peaks.peaks[bucket * 2]), Math.abs(peaks.peaks[bucket * 2 + 1]));
      }
      out.push(Math.min(1, level));
    }
    return out;
  }, [peaks]);
  return (
    <svg viewBox="0 0 80 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      {bars.map((level, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <rect key={index} x={index * 2 + 0.25} width={1.5} y={40 - Math.max(1, level * 36)} height={Math.max(1, level * 36)} fill="#a7f3d0" />
      ))}
    </svg>
  );
}

export interface AssetItemProps {
  asset: MediaAsset;
  view: MediaView;
  selected: boolean;
  fps: number;
  peaks?: WaveformPeaks;
  onSelect(): void;
  onContextMenu(event: MouseEvent): void;
  onAdd(): void;
  onRemove(): void;
  onRelink?(): void;
  onDragEnd(): void;
}

export const AssetItem = memo(function AssetItem({
  asset,
  view,
  selected,
  fps,
  peaks,
  onSelect,
  onContextMenu,
  onAdd,
  onRemove,
  onRelink,
  onDragEnd,
}: AssetItemProps): JSX.Element {
  const tr = useT();
  const Icon = KIND_ICONS[asset.kind];
  const seconds = assetLengthSeconds(asset, fps);
  const grid = view === 'grid';

  // The picture: the poster frame, a sound's waveform, or its kind's icon.
  const picture = asset.thumbnailUri ? (
    <img
      src={asset.thumbnailUri}
      alt=""
      draggable={false}
      className={`h-full w-full object-cover ${asset.hasAlphaChannel ? 'alpha-checkerboard' : ''} ${asset.missing ? 'opacity-40 grayscale' : ''}`}
    />
  ) : asset.kind === 'audio' && peaks ? (
    <span className="flex h-full w-full items-end bg-[#1f3d33] px-1 pb-1">
      <MiniWave peaks={peaks} />
    </span>
  ) : (
    <span className="flex h-full w-full items-center justify-center bg-panel-950">
      <Icon size={grid ? 22 : 16} className="text-slate-400" />
    </span>
  );

  const badges = (
    <>
      {asset.proxyUri && (
        <span className="rounded bg-sky-900/80 px-1 text-2xs text-sky-300" title={tr('media.proxyBadgeHint')}>
          {tr('media.proxyBadge')}
        </span>
      )}
      {asset.hasAlphaChannel && <span className="rounded bg-emerald-900/80 px-1 text-2xs text-emerald-300">{tr('media.alphaBadge')}</span>}
      {asset.missing && <span className="rounded bg-red-900/90 px-1 text-2xs text-red-200">{tr('media.missingBadge')}</span>}
    </>
  );

  // Over the picture's corner, on hover or keyboard focus: nothing moves.
  // A missing clip keeps its Relink button in view - it is what it needs.
  const actions = (
    <span
      className={`absolute flex items-center gap-0.5 rounded-control bg-panel-950/90 p-0.5 shadow-md shadow-black/40 transition-opacity duration-100 ${
        grid ? 'right-1 top-1' : 'right-1 top-1/2 -translate-y-1/2'
      } ${asset.missing && onRelink ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'}`}
    >
      {asset.missing && onRelink ? (
        <button
          type="button"
          data-testid="relink-asset"
          className="tool-button tool-button-dense px-1.5 text-2xs text-red-200"
          onClick={(event) => {
            event.stopPropagation();
            onRelink();
          }}
          {...tip(tr('media.relink'), { hint: tr('media.relinkHint'), named: false })}
        >
          <Link2 size={13} />
          {tr('media.relinkShort')}
        </button>
      ) : (
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          disabled={asset.missing}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
          {...tip(tr('media.addAtPlayhead'), { hint: tr('media.addAtPlayheadHint') })}
        >
          <Plus size={14} />
        </button>
      )}
      <button
        type="button"
        className="tool-button tool-button-dense w-6 px-0 hover:text-red-400"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        {...tip(tr('media.remove'))}
      >
        <Trash2 size={14} />
      </button>
    </span>
  );

  return (
    <li
      data-flip-key={asset.id}
      data-view={view}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      draggable={!asset.missing}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        // Copy onto the timeline, move onto a bin.
        event.dataTransfer.effectAllowed = 'copyMove';
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={onContextMenu}
      className={`${grid ? 'media-tile' : 'row-item'} group relative cursor-grab active:cursor-grabbing ${
        selected ? (grid ? 'media-tile-selected' : 'border-accent/70 bg-panel-800') : ''
      }`}
    >
      {grid ? (
        <>
          <span className="relative block aspect-video w-full overflow-hidden rounded-control bg-panel-950">
            {picture}
            {asset.kind !== 'image' && seconds > 0 && (
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-2xs tabular-nums text-slate-100">
                {durationBadge(seconds)}
              </span>
            )}
            <span className="absolute bottom-1 left-1 flex gap-0.5">{badges}</span>
            {actions}
          </span>
          <span className="mt-1 block truncate px-0.5 text-xs text-slate-200" title={asset.name}>
            {asset.name}
          </span>
        </>
      ) : (
        <>
          <span className="relative block aspect-video w-12 shrink-0 overflow-hidden rounded bg-panel-950">{picture}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-slate-200" title={asset.name}>
              {asset.name}
            </span>
            <span className="flex items-center gap-1 text-2xs text-slate-400">
              <span className="tabular-nums">
                {asset.width > 0 ? `${asset.width}×${asset.height} · ` : ''}
                {asset.kind === 'image' ? tr('media.still') : durationBadge(seconds)}
              </span>
              {badges}
            </span>
          </span>
          {actions}
        </>
      )}
    </li>
  );
});
