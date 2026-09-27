import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The before/after curtain across the picture, and the "grades off" badge.
 *
 * Resolve calls it a wipe, Premiere a split view: the picture without its
 * grade on one side of a line, with it on the other, the line dragged to
 * where the difference is. Here the ungraded side is the left, labelled
 * Before, as Premiere labels its split. The compositor draws both sides
 * (Compositor, ViewerCompare); this is only the line, its grip and the labels.
 *
 * Neither ever reaches a render or the scopes: they are the viewer's alone.
 */

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function CompareCurtain(): JSX.Element | null {
  const t = useT();
  const split = useProjectStore((state) => state.ui.compareSplit);
  const bypass = useProjectStore((state) => state.ui.gradeBypass);
  const setUi = useProjectStore((state) => state.setUi);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  if (bypass) {
    return (
      <span
        data-testid="grades-off-badge"
        className="pointer-events-none absolute left-2 top-2 rounded-control bg-black/70 px-1.5 py-0.5 text-2xs font-semibold text-amber-300"
      >
        {t('viewer.gradesOff')}
      </span>
    );
  }
  if (split === null) return null;

  const moveTo = (clientX: number): void => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setUi({ compareSplit: clamp01((clientX - box.left) / box.width) });
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    dragging.current = true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      setUi({ compareSplit: clamp01(split + (event.key === 'ArrowLeft' ? -step : step)) });
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setUi({ compareSplit: null });
    }
  };

  return (
    <div ref={boxRef} data-testid="compare-curtain" className="pointer-events-none absolute inset-0">
      <span className="absolute left-2 top-2 rounded-control bg-black/70 px-1.5 py-0.5 text-2xs font-semibold text-slate-100">
        {t('viewer.before')}
      </span>
      <span className="absolute right-2 top-2 rounded-control bg-black/70 px-1.5 py-0.5 text-2xs font-semibold text-slate-100">
        {t('viewer.after')}
      </span>
      {/* A wide strip to grab, with the line and its grip in the middle. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('viewer.curtain')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split * 100)}
        aria-valuetext={`${Math.round(split * 100)}%`}
        data-testid="compare-curtain-handle"
        className="group pointer-events-auto absolute inset-y-0 w-4 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
        style={{ left: `${split * 100}%` }}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (dragging.current) moveTo(event.clientX);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 h-7 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/50 bg-white group-focus-visible:ring-2 group-focus-visible:ring-accent-hover"
        />
      </div>
    </div>
  );
}

export default CompareCurtain;
