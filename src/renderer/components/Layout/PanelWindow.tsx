import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A panel in a window of its own, for a second monitor.
 *
 * Opened with `window.open` from the page itself, so the new window is
 * same-origin and runs in the same process: the panel keeps rendering from the
 * very same React tree and the very same store, with no messages to keep two
 * copies in step. The main process allows exactly these windows and nothing
 * else (setWindowOpenHandler).
 *
 * The window starts empty, so the page's styles are copied into it. A live
 * WebGL canvas moved this way keeps its context and carries on drawing -
 * measured in this Electron build before the viewer was allowed to detach -
 * which is why the viewer can move without a second renderer.
 *
 * Keys typed in a detached panel are handed to the main window, where the
 * editor's shortcuts live. Undocked panels losing the keyboard is the oldest
 * complaint about this feature in other editors.
 */

export interface PanelWindowProps {
  /** Shown as the window's title, and remembered under this name. */
  title: string;
  name: string;
  /** The user closed the window: the panel goes back where it came from. */
  onClose(): void;
  children: ReactNode;
  width?: number;
  height?: number;
}

interface Bounds {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

/**
 * True once the editor itself is going away.
 *
 * Electron closes a panel's window when the editor's window closes, and that
 * looks exactly like the user docking the panel by hand - so quitting the app
 * used to forget which panels were on the second monitor. A close that comes
 * after this flag is set is the app shutting down, and changes nothing.
 */
let editorClosing = false;
if (typeof window !== 'undefined') {
  const closing = (): void => {
    editorClosing = true;
  };
  window.addEventListener('beforeunload', closing);
  window.addEventListener('pagehide', closing);
}

const boundsKey = (name: string): string => `scf.panelWindow.${name}`;

function savedBounds(name: string, fallback: Bounds): Bounds {
  try {
    const stored = window.localStorage.getItem(boundsKey(name));
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<Bounds>;
    return {
      width: Number.isFinite(parsed.width) ? (parsed.width as number) : fallback.width,
      height: Number.isFinite(parsed.height) ? (parsed.height as number) : fallback.height,
      left: Number.isFinite(parsed.left) ? (parsed.left as number) : undefined,
      top: Number.isFinite(parsed.top) ? (parsed.top as number) : undefined,
    };
  } catch {
    return fallback;
  }
}

function rememberBounds(name: string, popout: Window): void {
  try {
    const bounds: Bounds = {
      width: popout.outerWidth,
      height: popout.outerHeight,
      left: popout.screenX,
      top: popout.screenY,
    };
    window.localStorage.setItem(boundsKey(name), JSON.stringify(bounds));
  } catch {
    // A panel that cannot remember where it was still opens.
  }
}

/** The page's styles, copied into a window that starts with none. */
function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      const style = target.createElement('style');
      style.textContent = Array.from(rules)
        .map((rule) => rule.cssText)
        .join('\n');
      target.head.appendChild(style);
    } catch {
      // A sheet that will not be read (a cross-origin one) is linked instead.
      const owner = sheet.ownerNode;
      if (owner instanceof HTMLLinkElement) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = owner.href;
        target.head.appendChild(link);
      }
    }
  }
}

export function PanelWindow({ title, name, onClose, children, width = 900, height = 620 }: PanelWindowProps): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const bounds = savedBounds(name, { width, height });
    const features = [
      `width=${Math.round(bounds.width)}`,
      `height=${Math.round(bounds.height)}`,
      bounds.left !== undefined ? `left=${Math.round(bounds.left)}` : '',
      bounds.top !== undefined ? `top=${Math.round(bounds.top)}` : '',
    ]
      .filter(Boolean)
      .join(',');

    const popout = window.open('about:blank', `scf-panel-${name}`, features);
    if (!popout) {
      onClose();
      return undefined;
    }

    popout.document.title = title;
    copyStyles(popout.document);
    popout.document.documentElement.lang = document.documentElement.lang;
    // The same ground and text colour as the editor, so a panel does not flash
    // white while it opens.
    popout.document.body.className = document.body.className;
    const mount = popout.document.createElement('div');
    mount.className = 'h-full w-full p-1.5';
    popout.document.body.appendChild(mount);
    setHost(mount);

    // The editor's shortcuts listen on the main window; a key pressed over a
    // detached panel is handed to it, unless a field there is being typed in.
    const forward = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      window.dispatchEvent(new KeyboardEvent(event.type, event));
    };
    popout.addEventListener('keydown', forward);

    const remember = (): void => rememberBounds(name, popout);
    popout.addEventListener('resize', remember);
    const closed = (): void => {
      remember();
      // The app shutting down takes its panel windows with it; that is not the
      // user docking them, so the layout is left as it is for next time.
      if (!editorClosing) onClose();
    };
    popout.addEventListener('beforeunload', closed);

    return () => {
      remember();
      popout.removeEventListener('keydown', forward);
      popout.removeEventListener('resize', remember);
      popout.removeEventListener('beforeunload', closed);
      setHost(null);
      popout.close();
    };
    // Opened once per detached panel; the title follows in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (host) host.ownerDocument.title = title;
  }, [host, title]);

  return host ? createPortal(children, host) : null;
}

export default PanelWindow;
