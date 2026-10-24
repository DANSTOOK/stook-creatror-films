import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether an element has come on screen yet - once it has, it stays so. The
 * library's tiles draw their pictures only then: sixty canvases given their
 * 2D contexts and drawn the moment a panel opened held the first frame up
 * for a quarter of a second, for tiles most of which were below the fold.
 *
 * One observer for every tile, not one each.
 */

const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function observe(element: Element, seen: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    seen();
    return () => undefined;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        waiting.get(entry.target)?.();
        waiting.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    // A little ahead of the fold, so a tile scrolled to is drawn as it arrives.
    { rootMargin: '160px 0px' },
  );
  waiting.set(element, seen);
  observer.observe(element);
  return () => {
    waiting.delete(element);
    observer?.unobserve(element);
  };
}

export function useOnScreen(ref: RefObject<Element>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return undefined;
    return observe(element, () => setSeen(true));
  }, [ref, seen]);
  return seen;
}
