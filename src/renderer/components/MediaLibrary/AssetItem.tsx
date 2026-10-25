import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { FileVideo, Image as ImageIcon, Link2, Music, Plus, Trash2 } from 'lucide-react';
import type { MediaAsset, MediaKind } from '@shared/types';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { ASSET_DRAG_TYPE } from '@renderer/components/Timeline/dropPlacement';
import { assetLengthSeconds } from '@renderer/media/assetLength';
import { useT } from '@renderer/i18n';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { setClipDragImage } from './dragGhost';
import { useLibraryDragStore } from './libraryDrag';

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

/**
 * How big the thumbnails are, as a factor on the size the panel's width
 * suggests (index.css, .media-grid): Premiere's Project panel and Resolve's
 * Media Pool both put this on a slider, and the panel's width alone cannot
 * know whether someone is looking for a shot or reading names.
 */
export const TILE_ZOOM_KEY = 'scf.mediaTileZoom';
export const TILE_ZOOM = { min: 0.6, max: 1.6, step: 0.05, initial: 1 } as const;

export function loadTileZoom(): number {
  try {
    const stored = Number(window.localStorage.getItem(TILE_ZOOM_KEY));
    return Number.isFinite(stored) && stored >= TILE_ZOOM.min && stored <= TILE_ZOOM.max ? stored : TILE_ZOOM.initial;
  } catch {
    return TILE_ZOOM.initial;
  }
}

export function saveTileZoom(zoom: number): void {
  try {
    window.localStorage.setItem(TILE_ZOOM_KEY, String(zoom));
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

/** How long the pointer rests on a video's thumbnail before it plays: one passing over plays nothing. */
export const HOVER_PLAY_MS = 250;

/** The thumbnail playing, stopped when another starts: one decoder for this, never a row of them. */
let stopPlaying: (() => void) | null = null;

/**
 * A video's thumbnail under the pointer plays, muted and on a loop, as
 * CapCut's media panel does: a shot is told by its movement as much as by
 * its first frame. The proxy when there is one, lighter to decode. It fades
 * in once its first frame is up - over the poster, so nothing flashes black -
 * and goes the moment the preview plays or the window is hidden.
 *
 * It takes no pointer events: what is under the pointer stays the poster, so
 * the video coming and going is no move at all. Otherwise its removal reached
 * React as the pointer entering the tile afresh, and it started again.
 */
function TilePlayback({ uri, onStop }: { uri: string; onStop(): void }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const previewPlaying = useProjectStore((state) => state.ui.isPlaying);

  useEffect(() => {
    if (previewPlaying) onStop();
  }, [previewPlaying, onStop]);

  useEffect(() => {
    stopPlaying?.();
    stopPlaying = onStop;
    const video = videoRef.current;
    // The window it is in: a detached media panel is a window of its own.
    const page = video?.ownerDocument ?? document;
    const hidden = (): void => {
      if (page.visibilityState === 'hidden') onStop();
    };
    page.addEventListener('visibilitychange', hidden);
    if (video) {
      video.muted = true;
      // Interrupted when the pointer leaves first: nothing to report.
      video.play().catch(() => undefined);
    }
    return () => {
      page.removeEventListener('visibilitychange', hidden);
      if (stopPlaying === onStop) stopPlaying = null;
      // The decoder goes now, not whenever the element is collected.
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [onStop]);

  return (
    <>
      <video
        ref={videoRef}
        data-testid="tile-playback"
        src={uri}
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden
        className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${shown ? 'opacity-100' : 'opacity-0'}`}
        onPlaying={() => setShown(true)}
        onTimeUpdate={(event) => {
          const { currentTime, duration } = event.currentTarget;
          if (barRef.current && duration > 0) barRef.current.style.transform = `scaleX(${currentTime / duration})`;
        }}
        onError={onStop}
      />
      {/* How far through the clip it is, along the bottom edge. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/15">
        <span ref={barRef} className="block h-full origin-left bg-accent transition-transform duration-200 ease-linear" style={{ transform: 'scaleX(0)' }} />
      </span>
    </>
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
  const analysing = useMediaStore((state) => state.analysing.includes(asset.uri));
  // A video's thumbnail plays while the pointer rests on it (TilePlayback) -
  // not with less motion asked for, nor while the preview plays or a render runs.
  const playable = grid && asset.kind === 'video' && !asset.missing;
  const [playing, setPlaying] = useState(false);
  const hoverTimer = useRef(0);
  const stopPlayback = useCallback((): void => {
    window.clearTimeout(hoverTimer.current);
    setPlaying(false);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // The picture: the poster frame, a sound's waveform, or its kind's icon.
  const picture = asset.thumbnailUri ? (
    <img
      src={asset.thumbnailUri}
      alt=""
      draggable={false}
      className={`h-full w-full object-cover ${asset.hasAlphaChannel ? 'alpha-checkerboard' : ''} ${asset.missing ? 'opacity-40 grayscale' : ''}`}
    />
  ) : asset.kind === 'audio' && peaks ? (
    <span className="scf-tab-enter flex h-full w-full items-end bg-[#1f3d33] px-1 pb-1">
      <MiniWave peaks={peaks} />
    </span>
  ) : asset.kind === 'audio' && analysing ? (
    // Its waveform is being read: a light sweeping where it will be.
    <span data-testid="asset-skeleton" className="scf-skeleton flex h-full w-full items-center justify-center bg-[#1f3d33]/60">
      <Icon size={grid ? 22 : 16} className="text-emerald-200/50" />
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
      onPointerEnter={
        playable
          ? () => {
              window.clearTimeout(hoverTimer.current);
              hoverTimer.current = window.setTimeout(() => {
                if (!motionReduced() && !motionQuiet()) setPlaying(true);
              }, HOVER_PLAY_MS);
            }
          : undefined
      }
      onPointerLeave={stopPlayback}
      onDragStart={(event) => {
        stopPlayback();
        event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        // Copy onto the timeline, move onto a bin.
        event.dataTransfer.effectAllowed = 'copyMove';
        // The card that follows the pointer, and the timeline told what is coming.
        setClipDragImage(event, asset.kind, asset.name, asset.kind !== 'image' && seconds > 0 ? durationBadge(seconds) : '');
        useLibraryDragStore.getState().setAsset(asset.id);
      }}
      onDragEnd={() => {
        useLibraryDragStore.getState().setAsset(null);
        onDragEnd();
      }}
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
            {playing && playable && <TilePlayback uri={asset.proxyUri ?? asset.uri} onStop={stopPlayback} />}
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
