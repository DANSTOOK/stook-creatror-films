import { useEffect, useState } from 'react';

/**
 * Keep something on screen for its exit animation.
 *
 * A dialog rendered as `{open && <Dialog />}` can only appear, never leave:
 * the moment `open` turns false it is gone. This keeps it mounted a little
 * longer with `closing` set, so it can play a short exit - about half its
 * entrance, as motion guidelines suggest - and removes it after. With reduced
 * motion requested, it is removed at once.
 */

/** Exit length; matches the `-out` animations in index.css. */
export const EXIT_MS = 130;

export function usePresence(open: boolean, exitMs = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    if (!mounted) return undefined;
    const reduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : exitMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted: open || mounted, closing: !open && mounted };
}
