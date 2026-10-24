import { useEffect, useRef, useState } from 'react';
import type { Clip } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { isMotionPreset, motionFromZone, motionHasFocus, motionZone, type FrameZone, type MotionPresetId } from '@renderer/fx/motion/presets';
import { setClipFx } from '@renderer/fx/motion/apply';
import { useZoneEditStore } from '@renderer/fx/motion/zoneEdit';

/**
 * Aiming a zoom: the part of the frame the zoom closes in on, drawn over the
 * picture as a frame of the picture's own shape, with the rest dimmed. Drag
 * it to move where the zoom goes; drag a corner to zoom closer (smaller) or
 * wider (larger). Each change is written as it is dragged, one undo step for
 * the drag, so the picture under it is the move as it now is.
 *
 * The zone is what the frame shows at the move's closest (motionZone); the
 * zoom scales about the point that keeps that zone in view, so it never
 * shows an edge of black.
 */

type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface Drag {
  grip: Grip;
  /** The pointer where the drag began, in fractions of the frame. */
  startX: number;
  startY: number;
  zone: FrameZone;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function ZoomZoneOverlay(): JSX.Element | null {
  const t = useT();
  const clipId = useZoneEditStore((state) => state.clipId);
  const stop = useZoneEditStore((state) => state.setClipId);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined)) as Clip | undefined;
  const selected = useProjectStore((state) => state.ui.selectedClipIds);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const motion = clip?.fx?.motion && isMotionPreset(clip.fx.motion.preset) && motionHasFocus(clip.fx.motion.preset) ? clip.fx.motion : undefined;
  const preset = motion?.preset as MotionPresetId | undefined;

  // The zone goes when its clip is no longer the one selected, or no longer zooms; Escape puts it away.
  useEffect(() => {
    if (clipId && (!motion || !selected.includes(clipId))) stop(null);
  }, [clipId, motion, selected, stop]);
  useEffect(() => {
    if (!clipId) return undefined;
    // Ahead of the editor's own Escape (which lets go of the selection): this
    // one only puts the zone away, and the clip stays selected.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId, stop]);

  if (!clip || !motion || !preset) return null;
  const zone = motionZone(preset, motion.amount, motion.focus);

  const at = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const begin = (grip: Grip) => (event: React.PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = at(event);
    setDrag({ grip, startX: point.x, startY: point.y, zone });
  };

  const move = (event: React.PointerEvent): void => {
    if (!drag) return;
    const point = at(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const start = drag.zone;
    let next: FrameZone;
    if (drag.grip === 'move') {
      next = { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
    } else {
      // A corner: the opposite one stays put, the size follows the pointer, the shape stays the frame's.
      const west = drag.grip === 'nw' || drag.grip === 'sw';
      const north = drag.grip === 'nw' || drag.grip === 'ne';
      const anchorX = west ? start.x + start.width : start.x;
      const anchorY = north ? start.y + start.height : start.y;
      const reach = Math.max(Math.abs(point.x - anchorX), Math.abs(point.y - anchorY));
      const room = Math.min(west ? anchorX : 1 - anchorX, north ? anchorY : 1 - anchorY);
      const size = clamp(reach, 0.05, room);
      next = { x: west ? anchorX - size : anchorX, y: north ? anchorY - size : anchorY, width: size, height: size };
    }
    const chosen = motionFromZone(preset, next);
    setClipFx(clip.id, { ...clip.fx, motion: { ...motion, amount: chosen.amount, focus: chosen.focus } }, `fx-zone:${clip.id}`);
  };

  const end = (): void => setDrag(null);
  const handle = (grip: Exclude<Grip, 'move'>, place: string): JSX.Element => (
    <span
      data-testid={`zoom-zone-${grip}`}
      onPointerDown={begin(grip)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={`absolute h-3.5 w-3.5 rounded-sm border-2 border-white bg-accent shadow ${place}`}
      style={{ cursor: grip === 'nw' || grip === 'se' ? 'nwse-resize' : 'nesw-resize', touchAction: 'none' }}
    />
  );

  return (
    <div ref={box} data-testid="zoom-zone" className="scf-rise absolute inset-0 z-10 overflow-hidden" onPointerDown={(event) => event.stopPropagation()}>
      <div
        data-testid="zoom-zone-frame"
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="absolute rounded-[3px] border-2 border-accent-hover"
        style={{
          left: `${zone.x * 100}%`,
          top: `${zone.y * 100}%`,
          width: `${zone.width * 100}%`,
          height: `${zone.height * 100}%`,
          // Everything outside the zone dimmed: what the zoom leaves out.
          boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.55)',
          cursor: drag?.grip === 'move' ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-contrast shadow">
          {t('fxp.zoneLabel')} · {Math.round((1 / zone.width) * 100)} %
        </span>
        {handle('nw', '-left-2 -top-2')}
        {handle('ne', '-right-2 -top-2')}
        {handle('sw', '-bottom-2 -left-2')}
        {handle('se', '-bottom-2 -right-2')}
      </div>
    </div>
  );
}
