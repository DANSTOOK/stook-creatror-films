import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { keyLabel } from '@renderer/i18n';

/**
 * Tooltips, drawn by the editor rather than by Windows.
 *
 * The native `title` tip is a pale box that takes a second and a half to
 * appear and cannot show a key. These come up after a short pause, say what
 * the control does and, where there is one, its shortcut, the way Final Cut
 * and Resolve label their toolbar icons. Once one is showing, moving to the
 * next icon shows its tip at once - reading a row of icons is one gesture.
 *
 * One layer for the whole page: a control opts in with `data-tooltip` (and
 * `data-shortcut`), usually through `tip()` below, so nothing per button has
 * to hold state or re-render. Keyboard focus shows the tip too, as the HIG
 * asks of help tags.
 */

const SHOW_DELAY_MS = 450;
/** After a tip has hidden, the next one within this long shows at once. */
const WARM_MS = 600;
const GAP_PX = 6;
const MARGIN_PX = 8;

interface TipProps {
  'aria-label'?: string;
  'data-tooltip': string;
  'data-shortcut'?: string;
  'aria-keyshortcuts'?: string;
}

/**
 * Props for a control that shows a tooltip.
 *
 * `label` is its accessible name - set it for icon-only buttons, where it is
 * the only name there is. `hint` is the longer line shown in the tip when it
 * says more than the name. `shortcut` is shown as a key and announced through
 * aria-keyshortcuts.
 */
export function tip(label: string, options: { shortcut?: string; hint?: string; named?: boolean } = {}): TipProps {
  const props: TipProps = { 'data-tooltip': options.hint ?? label };
  // A button with visible text already has its name; the tip only adds to it.
  if (options.named !== false) props['aria-label'] = label;
  if (options.shortcut) {
    props['data-shortcut'] = keyLabel(options.shortcut);
    props['aria-keyshortcuts'] = options.shortcut.replace(/Ctrl/g, 'Control');
  }
  return props;
}

interface Shown {
  text: string;
  shortcut: string | null;
  target: HTMLElement;
}

export function TooltipLayer(): JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let hiddenAt = 0;
    /** The control just pressed: no tip for it again until the pointer leaves it. */
    let pressed: HTMLElement | null = null;

    const read = (element: HTMLElement): Shown | null => {
      const text = element.getAttribute('data-tooltip');
      if (!text) return null;
      return { text, shortcut: element.getAttribute('data-shortcut'), target: element };
    };

    const hide = (): void => {
      window.clearTimeout(timer);
      if (current) hiddenAt = performance.now();
      current = null;
      setShown(null);
      setPosition(null);
    };

    const showFor = (element: HTMLElement, immediate: boolean): void => {
      window.clearTimeout(timer);
      current = element;
      const warm = performance.now() - hiddenAt < WARM_MS;
      const reveal = (): void => {
        if (current !== element || !element.isConnected) return;
        // A disabled control says nothing it can act on; its tip still helps.
        setShown(read(element));
      };
      if (immediate || warm) reveal();
      else timer = window.setTimeout(reveal, SHOW_DELAY_MS);
    };

    const onOver = (event: PointerEvent): void => {
      const element = (event.target as Element | null)?.closest?.('[data-tooltip]') as HTMLElement | null;
      if (element === current) return;
      if (element && element === pressed) return;
      pressed = null;
      if (!element) {
        if (current) hide();
        return;
      }
      if (current) hiddenAt = performance.now();
      showFor(element, false);
    };

    const onFocus = (event: FocusEvent): void => {
      const element = event.target as HTMLElement | null;
      if (!element?.matches?.('[data-tooltip]') || !element.matches(':focus-visible')) return;
      showFor(element, true);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current) hide();
    };

    // A press means the tip has been read or is not wanted; a scroll moves
    // what it points at.
    document.addEventListener('pointerover', onOver, true);
    const onDown = (event: PointerEvent): void => {
      pressed = (event.target as Element | null)?.closest?.('[data-tooltip]') as HTMLElement | null;
      hide();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Below the control, centred; above it when there is no room; always on screen.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!shown || !bubble) return;
    const box = shown.target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    let top = box.bottom + GAP_PX;
    if (top + height + MARGIN_PX > window.innerHeight) top = box.top - GAP_PX - height;
    const left = Math.max(MARGIN_PX, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - MARGIN_PX));
    setPosition({ left, top: Math.max(MARGIN_PX, top) });
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={bubbleRef}
      role="tooltip"
      data-state={position ? 'open' : 'measuring'}
      className="pointer-events-none fixed z-[200] flex max-w-[280px] items-center gap-2 rounded-menu border border-panel-600 bg-panel-800 px-2 py-1 text-xs text-slate-100 shadow-lg shadow-black/50"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
    >
      <span className="leading-snug">{shown.text}</span>
      {shown.shortcut && (
        <kbd className="shrink-0 rounded border border-panel-600 bg-panel-900 px-1.5 py-px font-sans text-2xs text-slate-300">
          {shown.shortcut}
        </kbd>
      )}
    </div>
  );
}

export default TooltipLayer;
