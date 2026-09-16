import { flushSync } from 'react-dom';

/**
 * Swapping whole screens with the browser's own View Transition.
 *
 * Going from the start screen to the editor replaces everything on screen:
 * panels, a WebGL viewport and a timeline canvas. Cross-fading that in
 * JavaScript would mean keeping both trees alive and animating them frame by
 * frame on the main thread - the same thread that is decoding video. The
 * browser instead snapshots the old and new states and cross-fades them on the
 * compositor, which costs nothing per frame here and cannot stutter because
 * the editor is busy waking up.
 *
 * The animation itself lives in index.css (::view-transition-old/new).
 */

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Apply `update` inside a view transition, when the browser has one.
 *
 * `flushSync` is what makes this work with React: the transition captures the
 * DOM the moment the callback returns, so the state change has to have been
 * painted by then rather than scheduled for later.
 *
 * Falls back to applying the change directly - no transition, same result -
 * when the API is missing or the user asked for less motion. Errors from the
 * transition itself are swallowed on purpose: a failed animation must never
 * cost the user the action they asked for.
 */
export async function withViewTransition(update: () => void): Promise<void> {
  // Typed as always present by the DOM library, but this also runs in a plain
  // browser during development, where it may not be.
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }

  try {
    const transition = document.startViewTransition(() => {
      flushSync(update);
    });
    await transition.finished;
  } catch {
    // The DOM has been updated either way; only the animation was lost.
  }
}
