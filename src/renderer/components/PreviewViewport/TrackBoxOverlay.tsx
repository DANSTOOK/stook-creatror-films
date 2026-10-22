import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { useTrackEditStore } from '@renderer/edit/trackEdit';
import type { FrameBox } from '@renderer/edit/track';

/**
 * Marking the thing a clip is to follow: a box over the picture, round the
 * thing. Drag inside it to move it, drag a corner to size it, or drag on the
 * picture outside it to draw a new one. The box is only a mark - nothing is
 * written until Follow is pressed in the inspector.
 */

type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'draw';

interface Drag {
  grip: Grip;
  startX: number;
  startY: number;
  box: FrameBox;
}

const MIN = 0.02;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A box from two corners, kept inside the frame. */
function between(ax: number, ay: number, bx: number, by: number): FrameBox {
  const left = clamp(Math.min(ax, bx), 0, 1);
  const right = clamp(Math.max(ax, bx), 0, 1);
  const top = clamp(Math.min(ay, by), 0, 1);
  const bottom = clamp(Math.max(ay, by), 0, 1);
  const width = Math.max(MIN, right - left);
  const height = Math.max(MIN, bottom - top);
  return { x: clamp(left + width / 2, width / 2, 1 - width / 2), y: clamp(top + height / 2, height / 2, 1 - height / 2), width, height };
}

export function TrackBoxOverlay(): JSX.Element | null {
  const t = useT();
  const clipId = useTrackEditStore((state) => state.clipId);
  const box = useTrackEditStore((state) => state.box);
  const setBox = useTrackEditStore((state) => state.setBox);
  const stop = useTrackEditStore((state) => state.stop);
  const exists = useProjectStore((state) => Boolean(clipId && state.project.clips[clipId]));
  const selected = useProjectStore((state) => state.ui.selectedClipIds);
  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // The mark goes when its clip is no longer the one selected; Escape puts it away.
  useEffect(() => {
    if (clipId && (!exists || !selected.includes(clipId))) stop();
  }, [clipId, exists, selected, stop]);
  useEffect(() => {
    if (!clipId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId, stop]);

  if (!clipId || !exists) return null;

  const at = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const begin = (grip: Grip) => (event: React.PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = at(event);
    setDrag({ grip, startX: point.x, startY: point.y, box });
  };

  const move = (event: React.PointerEvent): void => {
    if (!drag) return;
    const point = at(event);
    const start = drag.box;
    if (drag.grip === 'draw') {
      setBox(between(drag.startX, drag.startY, point.x, point.y));
    } else if (drag.grip === 'move') {
      setBox({
        ...start,
        x: clamp(start.x + point.x - drag.startX, start.width / 2, 1 - start.width / 2),
        y: clamp(start.y + point.y - drag.startY, start.height / 2, 1 - start.height / 2),
      });
    } else {
      // A corner: the opposite one stays put.
      const west = drag.grip === 'nw' || drag.grip === 'sw';
      const north = drag.grip === 'nw' || drag.grip === 'ne';
      const anchorX = west ? start.x + start.width / 2 : start.x - start.width / 2;
      const anchorY = north ? start.y + start.height / 2 : start.y - start.height / 2;
      setBox(between(anchorX, anchorY, point.x, point.y));
    }
  };

  const end = (): void => setDrag(null);
  const handle = (grip: 'nw' | 'ne' | 'sw' | 'se', place: string): JSX.Element => (
    <span
      data-testid={`track-box-${grip}`}
      onPointerDown={begin(grip)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={`absolute h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-500 shadow ${place}`}
      style={{ cursor: grip === 'nw' || grip === 'se' ? 'nwse-resize' : 'nesw-resize', touchAction: 'none' }}
    />
  );

  return (
    <div
      ref={frame}
      data-testid="track-box-overlay"
      className="scf-rise absolute inset-0 z-10 cursor-crosshair overflow-hidden"
      onPointerDown={begin('draw')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      style={{ touchAction: 'none' }}
    >
      <div
        data-testid="track-box"
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="absolute rounded-[3px] border-2 border-dashed border-emerald-400"
        style={{
          left: `${(box.x - box.width / 2) * 100}%`,
          top: `${(box.y - box.height / 2) * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
          boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.35)',
          cursor: drag?.grip === 'move' ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        <span className="pointer-events-none absolute -top-6 left-0 whitespace-nowrap rounded bg-emerald-600 px-1.5 py-0.5 text-2xs font-semibold text-white shadow">
          {t('track.boxLabel')}
        </span>
        {handle('nw', '-left-2 -top-2')}
        {handle('ne', '-right-2 -top-2')}
        {handle('sw', '-bottom-2 -left-2')}
        {handle('se', '-bottom-2 -right-2')}
      </div>
    </div>
  );
}
