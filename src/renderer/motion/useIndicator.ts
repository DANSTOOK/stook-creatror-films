import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * The sliding highlight of a segmented control or a tab list.
 *
 * One of several is chosen: rather than the old segment going dark and the
 * new one lighting up somewhere else, the highlight travels from one to the
 * other, which says "this replaced that". It is an element of its own behind
 * the segments, moved with a transform (index.css, `.scf-indicator`) on the
 * quick spring with the bounce. Clicking along the row mid-move retargets it
 * from wherever it is, because it is a CSS transition.
 *
 * The position is written straight onto the element in a layout effect, never
 * kept in React state: a position in state is a second render per change.
 * The first placement, and any placement after the control is resized, is
 * instant - there is nothing to explain when nothing was chosen.
 */
export function useIndicator<C extends HTMLElement, I extends HTMLElement>(
  /** What is chosen now; the effect runs when it changes. */
  chosen: string,
): { containerRef: RefObject<C>; indicatorRef: RefObject<I> } {
  const containerRef = useRef<C>(null);
  const indicatorRef = useRef<I>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return undefined;

    const place = (animate: boolean): void => {
      const target = container.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]');
      if (!target) {
        indicator.style.opacity = '0';
        return;
      }
      if (!animate) indicator.style.transition = 'none';
      indicator.style.opacity = '1';
      indicator.style.width = `${target.offsetWidth}px`;
      indicator.style.height = `${target.offsetHeight}px`;
      indicator.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
      if (!animate) {
        // Commit the jump before transitions come back on.
        void indicator.offsetWidth;
        indicator.style.transition = '';
      }
    };

    place(placed.current);
    placed.current = true;

    // An observer reports once as it starts; that is not a resize.
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) first = false;
      else place(false);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [chosen]);

  return { containerRef, indicatorRef };
}
