import { useLayoutEffect, useRef, type RefObject } from 'react';
import { EASE_EXIT, EXIT_FAST_MS, EXIT_MS, REDUCED_MS } from './tokens.generated';
import { motionQuiet, motionReduced } from './environment';

/**
 * Exits that never keep anything waiting.
 *
 * React removes a menu, a toast or a panel the moment its state says so, and
 * that is the behaviour worth keeping: the next click, the layout, a screen
 * reader and the interface tests all see the final state at once. What leaves
 * the screen is a GHOST - a copy of the element taken just before it went,
 * dead to the pointer, the keyboard and assistive technology, that plays the
 * exit and removes itself.
 *
 * The copies live in a CLOSED shadow root. Nothing outside can reach into it:
 * not a screen reader's tree, not `document.querySelector`, and not a
 * test's `getByText`, which would otherwise find a menu's labels twice for the
 * tenth of a second the copy is fading. The page's own stylesheets are copied
 * in once, so the ghost is drawn exactly as the element was.
 *
 * No ghosts while the video plays or a render runs: things simply go.
 */

export type GhostExit = 'menu' | 'pop' | 'toast' | 'fade' | 'slide-left' | 'slide-right' | 'slide-down';

let layer: { host: HTMLElement; root: ShadowRoot } | null = null;

function sheetFromPage(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === 'undefined') return null;
  const sheet = new CSSStyleSheet();
  const rules: string[] = [];
  for (const styleSheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(styleSheet.cssRules)) rules.push(rule.cssText);
    } catch {
      // A stylesheet from another origin cannot be read; there are none here.
    }
  }
  // Only the exit animates a ghost: its own entrance must not replay.
  rules.push('[data-ghost], [data-ghost] * { transition: none !important; animation: none !important; }');
  try {
    sheet.replaceSync(rules.join('\n'));
  } catch {
    return null;
  }
  return sheet;
}

function ghostLayer(): { host: HTMLElement; root: ShadowRoot } | null {
  if (layer?.host.isConnected) return layer;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:250;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = sheetFromPage();
  if (!sheet) return null;
  root.adoptedStyleSheets = [sheet];
  document.body.appendChild(host);
  layer = { host, root };
  return layer;
}

/** The exit, from wherever the element was (mid-entrance included). */
function exitFrames(kind: GhostExit, from: Keyframe): Keyframe[] {
  if (motionReduced()) return [{ opacity: from.opacity }, { opacity: 0 }];
  const base = from.transform && from.transform !== 'none' ? `${from.transform} ` : '';
  const to: Record<GhostExit, string> = {
    menu: 'scale(0.97)',
    pop: 'translateY(4px) scale(0.97)',
    toast: 'translateX(24px)',
    fade: 'translateY(0)',
    'slide-left': 'translateX(-16px)',
    'slide-right': 'translateX(16px)',
    'slide-down': 'translateY(16px)',
  };
  return [
    { opacity: from.opacity, transform: from.transform ?? 'none' },
    { opacity: 0, transform: `${base}${to[kind]}` },
  ];
}

/**
 * Leave a copy of `element` playing its exit. Call it just before the element
 * is removed - a layout effect's cleanup is the place - while it is still in
 * the page and measurable. Returns without doing anything when no exit should
 * play.
 */
export function leaveGhost(element: HTMLElement | null, kind: GhostExit, options: { duration?: number } = {}): void {
  if (!element || !element.isConnected || motionQuiet()) return;
  if (typeof element.animate !== 'function') return;
  const target = ghostLayer();
  if (!target) return;

  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;

  // Where it sits without its current transform, and that transform as the
  // first frame: a menu closed half-way through growing leaves from there.
  const from: Keyframe = { opacity: style.opacity, transform: style.transform };
  const previousTransform = element.style.transform;
  const previousTransition = element.style.transition;
  element.style.transition = 'none';
  element.style.transform = 'none';
  const box = element.getBoundingClientRect();
  element.style.transform = previousTransform;
  element.style.transition = previousTransition;
  if (box.width === 0 || box.height === 0) return;

  const copy = element.cloneNode(true) as HTMLElement;
  // Canvases copy empty; paint what they showed.
  const sources = element.querySelectorAll('canvas');
  const copies = copy.querySelectorAll('canvas');
  sources.forEach((source, index) => {
    const canvas = copies[index];
    try {
      canvas?.getContext('2d')?.drawImage(source, 0, 0);
    } catch {
      // A WebGL canvas without preserved buffers copies blank; it is gone in 120 ms.
    }
  });

  copy.setAttribute('data-ghost', '');
  copy.removeAttribute('id');
  copy.style.position = 'fixed';
  copy.style.left = `${box.left}px`;
  copy.style.top = `${box.top}px`;
  copy.style.width = `${box.width}px`;
  copy.style.height = `${box.height}px`;
  copy.style.margin = '0';
  copy.style.transformOrigin = style.transformOrigin;
  copy.style.zIndex = style.zIndex === 'auto' ? '0' : style.zIndex;
  copy.style.pointerEvents = 'none';
  target.root.appendChild(copy);

  const duration = motionReduced()
    ? REDUCED_MS
    : (options.duration ?? (kind === 'menu' || kind === 'fade' ? EXIT_FAST_MS : EXIT_MS));
  const animation = copy.animate(exitFrames(kind, from), { duration, easing: EASE_EXIT, fill: 'forwards' });
  const remove = (): void => copy.remove();
  animation.addEventListener('finish', remove);
  animation.addEventListener('cancel', remove);
  // Belt and braces: a ghost never outlives its exit by much.
  window.setTimeout(remove, duration + 200);
}

/**
 * A ref for an element that should leave with a ghost when its component
 * unmounts. The component's own layout-effect cleanup runs before React
 * removes its elements, so the element is still there to copy.
 */
export function useExitGhost<T extends HTMLElement>(kind: GhostExit): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const openedAt = performance.now();
    const element = ref.current;
    return () => {
      // StrictMode's rehearsal unmount in development, not a real exit.
      if (performance.now() - openedAt < 40) return;
      leaveGhost(ref.current ?? element, kind);
    };
  }, [kind]);
  return ref;
}

/** How many ghosts are on screen now. For the motion tests. */
export function ghostCount(): number {
  return layer?.root.childElementCount ?? 0;
}

/** Build the copy of the page's styles while nothing is happening, not on the first exit. */
export function prepareGhosts(): void {
  const idle = (window as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  const build = (): void => void ghostLayer();
  if (idle) idle(build, { timeout: 3000 });
  else window.setTimeout(build, 1000);
}
