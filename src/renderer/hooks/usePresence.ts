import { useEffect, useState } from 'react';
import { EXIT_MS, REDUCED_MS } from '@renderer/motion/tokens.generated';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';

/**
 * Keep something on screen for its exit.
 *
 * A dialog rendered as `{open && <Dialog />}` can only appear, never leave:
 * the moment `open` turns false it is gone. This keeps it mounted for the
 * exit (`closing` set), then removes it.
 *
 * Interruptible. Opened again while it is still leaving, it is the same
 * element that comes back: `closing` clears, and because the motion is made
 * of CSS transitions (index.css, "Motion") it turns round from wherever it
 * had got to instead of jumping to the start of its entrance. Nothing queues.
 *
 * The exit is short on purpose - `EXIT_MS`, 120 ms, the length of the exit
 * transitions - so nothing that waits for the dialog to go (the user, a test)
 * waits long. With reduced motion it is the 100 ms fade; while the video
 * plays or a render runs it goes at once.
 */

export { EXIT_MS };

export function usePresence(open: boolean, exitMs = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    if (!mounted) return undefined;
    const wait = motionQuiet() ? 0 : motionReduced() ? Math.min(exitMs, REDUCED_MS) : exitMs;
    const timer = window.setTimeout(() => setMounted(false), wait);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted: open || mounted, closing: !open && mounted };
}
