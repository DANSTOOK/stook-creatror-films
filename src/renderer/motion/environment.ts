import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * What the page's motion has to know, written on <html> for the CSS.
 *
 *   data-motion="reduced"   Windows asks for less motion: fades of 100 ms,
 *                           nothing slides, scales or bounces.
 *   data-playing            the preview is playing,
 *   data-exporting          a render is running: nothing decorative runs,
 *                           and nothing is blurred behind a dialog or a menu,
 *                           because a backdrop blur is recomputed on every
 *                           frame of the video under it.
 *   data-hidden             the window cannot be seen: endless animations
 *                           (the start screen's light) stop.
 *
 * Attributes rather than React state, so none of this re-renders anything:
 * a selector in index.css reads them, and code asks the functions below.
 *
 * There is no setting in the app for it. Reduced motion follows Windows
 * (Settings > Accessibility > Visual effects > Animation effects), through
 * both the media query Chromium keeps current and the value the main process
 * read from the system as the window opened.
 */

const root = (): HTMLElement | null => (typeof document === 'undefined' ? null : document.documentElement);

function setFlag(name: string, on: boolean): void {
  const element = root();
  if (!element) return;
  if (on) element.setAttribute(name, '');
  else element.removeAttribute(name);
}

/** Fades only: the system asked for less motion. */
export function motionReduced(): boolean {
  return root()?.getAttribute('data-motion') === 'reduced';
}

/** Playing or rendering: the picture and the audio come first, nothing extra moves. */
export function motionQuiet(): boolean {
  const element = root();
  return Boolean(element && (element.hasAttribute('data-playing') || element.hasAttribute('data-exporting')));
}

/** A render has started or stopped (ExportDialog, the YouTube upload's render). */
export function setExporting(on: boolean): void {
  setFlag('data-exporting', on);
}

let installed = false;

/** Once, before the first render (main.tsx). */
export function installMotionEnvironment(): void {
  const element = root();
  if (!element || installed) return;
  installed = true;

  const fromSystem = typeof window !== 'undefined' && window.filmora?.systemReducedMotion === true;
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const applyMotion = (): void => {
    element.setAttribute('data-motion', fromSystem || query?.matches ? 'reduced' : 'full');
  };
  applyMotion();
  query?.addEventListener('change', applyMotion);

  setFlag('data-playing', useProjectStore.getState().ui.isPlaying);
  useProjectStore.subscribe((state, previous) => {
    if (state.ui.isPlaying !== previous.ui.isPlaying) setFlag('data-playing', state.ui.isPlaying);
  });

  const applyVisibility = (): void => setFlag('data-hidden', document.visibilityState === 'hidden');
  applyVisibility();
  document.addEventListener('visibilitychange', applyVisibility);
}
