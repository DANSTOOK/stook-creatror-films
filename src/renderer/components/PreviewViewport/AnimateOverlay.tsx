import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useDrawStore } from '@renderer/animation/drawStore';
import { exposureAt, layerBounds } from '@renderer/animation/model';
import { chainOf, placeOf } from '@renderer/animation/motion';

/**
 * The animate tool: moving a drawing about on the picture.
 *
 * OpenToonz's edit tool, which it calls Animate, does this for a whole column
 * - drag the picture to move it, a corner to size it, a ring to turn it - and
 * writes the result as keyframes. This is the same idea for one drawing
 * layer, writing the keyframes the rest of this app already uses.
 *
 * It is a separate overlay from the drawing one, and only one of them is
 * mounted at a time: a pointer cannot both lay a line down and pick a drawing
 * up, and a tool that guesses which you meant gets it wrong.
 *
 * A whole drag is ONE undo step, through the store's merge key. Without that,
 * dragging across the frame would leave a hundred steps to undo.
 */

type Grip = 'move' | 'scale' | 'rotate';

interface Drag {
  grip: Grip;
  /** Where the pointer went down, in fractions of the frame. */
  startX: number;
  startY: number;
  /** What the layer's motion was when the drag began. */
  from: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  /** The box's middle when the drag began, for measuring a turn or a scale against. */
  pivotX: number;
  pivotY: number;
  key: string;
}

export function AnimateOverlay(): JSX.Element | null {
  const clipId = useDrawStore((state) => state.clipId);
  const mode = useDrawStore((state) => state.mode);
  const layerId = useDrawStore((state) => state.layerId);
  const stop = useDrawStore((state) => state.stop);
  const clip = useProjectStore((state) => (clipId ? state.project.clips[clipId] : undefined));
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const setLayerKeyframe = useProjectStore((state) => state.setLayerKeyframe);

  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!clipId || mode !== 'animate') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId, mode, stop]);

  const anim = clip?.anim;
  if (!clipId || !anim || mode !== 'animate') return null;

  const layer = anim.layers.find((entry) => entry.id === layerId) ?? anim.layers[anim.layers.length - 1];
  if (!layer) return null;

  const exposure = exposureAt(anim, clip, currentFrame);
  const box = layerBounds(layer, exposure);
  // Nothing drawn here: no box, and nothing to take hold of. Saying so beats
  // a handle that moves an invisible thing.
  if (!box) {
    return (
      <div data-testid="animate-overlay-empty" className="pointer-events-none absolute inset-0 z-20 grid place-items-end justify-center p-6">
        <span className="rounded-control bg-slate-900/80 px-2 py-1 text-2xs text-slate-300 ring-1 ring-white/10">—</span>
      </div>
    );
  }

  const place = placeOf(layer.motion, currentFrame);
  // Where the box ends up on screen: its own place, and every place it hangs
  // from, exactly as the renderer stacks them.
  const chain = chainOf(anim.layers, layer);
  let offsetX = 0;
  let offsetY = 0;
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  for (const link of chain) {
    const linkPlace = placeOf(link.motion, currentFrame);
    offsetX += linkPlace.x;
    offsetY += linkPlace.y;
    scaleX *= linkPlace.scaleX;
    scaleY *= linkPlace.scaleY;
    rotation += linkPlace.rotation;
  }

  const midX = box.x + box.width / 2 + offsetX;
  const midY = box.y + box.height / 2 + offsetY;

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
    setDrag({
      grip,
      startX: point.x,
      startY: point.y,
      from: { x: place.x, y: place.y, scaleX: place.scaleX, scaleY: place.scaleY, rotation: place.rotation },
      pivotX: midX,
      pivotY: midY,
      // One key for the whole drag, so it undoes in one go.
      key: `anim-${grip}-${layer.id}-${Date.now()}`,
    });
  };

  const move = (event: React.PointerEvent): void => {
    if (!drag) return;
    const point = at(event);
    if (drag.grip === 'move') {
      setLayerKeyframe(clipId, layer.id, 'position', currentFrame, { x: drag.from.x + point.x - drag.startX, y: drag.from.y + point.y - drag.startY }, drag.key);
      return;
    }
    if (drag.grip === 'rotate') {
      // The turn between where the pointer was and where it is, about the middle.
      const was = Math.atan2(drag.startY - drag.pivotY, drag.startX - drag.pivotX);
      const now = Math.atan2(point.y - drag.pivotY, point.x - drag.pivotX);
      let degrees = drag.from.rotation + ((now - was) * 180) / Math.PI;
      // Shift: a quarter turn at a time, which is what a hand usually wants.
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      setLayerKeyframe(clipId, layer.id, 'rotation', currentFrame, degrees, drag.key);
      return;
    }
    // Scale: how much further the pointer is from the middle than it was.
    const was = Math.hypot(drag.startX - drag.pivotX, drag.startY - drag.pivotY);
    const now = Math.hypot(point.x - drag.pivotX, point.y - drag.pivotY);
    if (was < 0.004) return;
    const factor = Math.max(0.05, now / was);
    setLayerKeyframe(clipId, layer.id, 'scale', currentFrame, { x: drag.from.scaleX * factor, y: drag.from.scaleY * factor }, drag.key);
  };

  const end = (): void => setDrag(null);
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  return (
    <div ref={frame} data-testid="animate-overlay" className="absolute inset-0 z-20" style={{ touchAction: 'none' }}>
      <div
        data-testid="animate-box"
        onPointerDown={begin('move')}
        {...handlers}
        className="absolute cursor-grab border-2 border-dashed border-cyan-400/90"
        style={{
          left: `${(midX - (box.width * scaleX) / 2) * 100}%`,
          top: `${(midY - (box.height * scaleY) / 2) * 100}%`,
          width: `${box.width * scaleX * 100}%`,
          height: `${box.height * scaleY * 100}%`,
          transform: `rotate(${rotation}deg)`,
          cursor: drag?.grip === 'move' ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        {/* Size it: the corner, as every editor puts it. */}
        <span
          data-testid="animate-scale"
          onPointerDown={begin('scale')}
          {...handlers}
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 rounded-sm border-2 border-white bg-cyan-500 shadow"
          style={{ cursor: 'nwse-resize', touchAction: 'none' }}
        />
        {/* Turn it: the stalk above, as every editor puts that. */}
        <span
          data-testid="animate-rotate"
          onPointerDown={begin('rotate')}
          {...handlers}
          className="absolute -top-6 left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-white bg-cyan-500 shadow"
          style={{ cursor: 'grab', touchAction: 'none' }}
        />
      </div>
    </div>
  );
}
