import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LAYOUT_STEP_PX } from '@renderer/layout/layoutSizes';

/**
 * A draggable border between two panels.
 *
 * Pointer capture keeps the drag alive when the pointer crosses the preview's
 * canvas or leaves the window, which a mousemove listener on the handle alone
 * would lose. It reports the distance from where the drag began, not per-move
 * deltas, so a dropped event cannot make the panel drift from the pointer.
 *
 * Focusable too: the arrow keys move it, Shift moves further, and a
 * double-click puts the panel back to its default size.
 */

export interface SplitterProps {
  /** `vertical` is a bar between columns (it resizes widths); `horizontal` sits between rows. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  /** Drag began: the caller remembers the size it started from. */
  onDragStart(): void;
  /** Pointer distance from the start of the drag, right or down positive. */
  onDrag(offsetPx: number): void;
  onDragEnd(): void;
  /** A keyboard step, right or down positive. */
  onStep(offsetPx: number): void;
  onReset(): void;
}

export function Splitter({
  orientation,
  label,
  value,
  min,
  max,
  onDragStart,
  onDrag,
  onDragEnd,
  onStep,
  onReset,
}: SplitterProps): JSX.Element {
  const origin = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';

  const at = (event: PointerEvent<HTMLDivElement>): number => (vertical ? event.clientX : event.clientY);

  const finish = (event: PointerEvent<HTMLDivElement>): void => {
    if (origin.current === null) return;
    origin.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = '';
    onDragEnd();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    // The editor's shortcuts listen on the window, and there the arrows step
    // the playhead or nudge the selected clips. A border being moved with the
    // keyboard used to do both at once: resizing a panel shifted the edit.
    event.stopPropagation();
    const step = LAYOUT_STEP_PX * (event.shiftKey ? 4 : 1);
    onStep(event.key === forward ? step : -step);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} - drag, or double-click to reset`}
      className={`group relative shrink-0 touch-none outline-none ${
        vertical ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'
      }`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = at(event);
        setDragging(true);
        // Held on the body too, so the cursor does not flicker over other panels.
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
        onDragStart();
      }}
      onPointerMove={(event) => {
        if (origin.current !== null) onDrag(at(event) - origin.current);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span
        // The grip thickens under the pointer by scaling, not by growing: a
        // width change here would lay out both panels on every frame.
        className={`pointer-events-none absolute rounded-full transition-[background-color,transform] duration-150 ${
          vertical
            ? 'inset-y-2 left-1/2 w-0.5 -translate-x-1/2 group-hover:scale-x-[2.5] group-focus-visible:scale-x-[2.5]'
            : 'inset-x-2 top-1/2 h-0.5 -translate-y-1/2 group-hover:scale-y-[2.5] group-focus-visible:scale-y-[2.5]'
        } ${
          dragging ? (vertical ? 'scale-x-[2.5]' : 'scale-y-[2.5]') : ''
        } ${
          dragging
            ? 'bg-accent'
            : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent/80'
        }`}
      />
    </div>
  );
}

export default Splitter;
