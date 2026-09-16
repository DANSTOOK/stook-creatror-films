import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './viewTransition';

/**
 * Slide list items to their new places instead of jumping there (FLIP).
 *
 * When a clip is filed into a bin, or a search narrows the list, every item
 * below the change lands somewhere new. Without this they teleport, and the
 * eye loses which item is which. FLIP measures where things were (First),
 * lets the browser lay out where they now are (Last), Inverts the difference
 * as a transform, and Plays it back to zero - so the browser does the layout
 * once and the animation itself is a compositor-only transform.
 *
 * Items are matched by a `data-flip-key`, so an item keeps its identity even
 * when React reuses the element for something else.
 */

/** How long an item takes to travel to its new place. */
const TRAVEL_MS = 260;
/** Anything further than this is a jump, not a move - fade the change instead. */
const MAX_TRAVEL_PX = 1200;

type Rects = Map<string, DOMRect>;

function measure(container: HTMLElement | null): Rects {
  const rects: Rects = new Map();
  if (!container) return rects;
  for (const item of container.querySelectorAll<HTMLElement>('[data-flip-key]')) {
    const key = item.dataset.flipKey;
    if (key) rects.set(key, item.getBoundingClientRect());
  }
  return rects;
}

/**
 * Animate the items inside `ref` whenever `token` changes.
 *
 * `token` is whatever says the list is different now - a joined list of ids, a
 * count, a filter string. The measuring happens in a layout effect, before the
 * browser paints, which is what keeps the first frame from flashing.
 */
export function useFlip(ref: { current: HTMLElement | null }, token: string): void {
  const previous = useRef<Rects>(new Map());

  useLayoutEffect(() => {
    const container = ref.current;
    const before = previous.current;
    const after = measure(container);
    previous.current = after;

    if (!container || before.size === 0 || prefersReducedMotion()) return;
    if (typeof container.animate !== 'function') return;

    for (const item of container.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const key = item.dataset.flipKey;
      const from = key ? before.get(key) : undefined;
      const to = key ? after.get(key) : undefined;
      if (!from || !to) continue;

      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || Math.abs(dx) > MAX_TRAVEL_PX || Math.abs(dy) > MAX_TRAVEL_PX) continue;

      item.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: TRAVEL_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', composite: 'replace' },
      );
    }
    // `token` is the signal; the rects are read from the DOM, not from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}
