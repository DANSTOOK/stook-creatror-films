import { useEffect, useState } from 'react';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { addFrameWindow, cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { spaceFromSlider } from '@renderer/hooks/spaceFromSlider';

/**
 * The plumbing behind every window of the editor's own: a detached panel
 * (Layout/PanelWindow) and the text-to-speech window (TextToSpeech) both open
 * this way. It is factored out here so the two share one proven mechanism
 * rather than each keeping its own copy.
 *
 * Opened with `window.open` from the page itself, so the new window is
 * same-origin and runs in the same process: whatever is portalled into the
 * returned host keeps rendering from the very same React tree and the very
 * same store, with no messages to keep two copies in step. The main process
 * allows exactly these windows and nothing else (setWindowOpenHandler).
 *
 * The window starts empty, so the page's styles are copied into it, and a live
 * WebGL canvas moved this way keeps its context and carries on drawing. Keys
 * typed in the window are handed to the main window, where the editor's
 * shortcuts live - undocked windows losing the keyboard is the oldest
 * complaint about this feature in other editors.
 */

export interface DetachedWindowOptions {
  /** A stable id: the window's target name and the key its bounds are saved under. */
  name: string;
  /** The window's own title, for the taskbar and Alt+Tab. */
  title: string;
  /** The window was closed by the user: whatever opened it should tidy up. */
  onClose(): void;
  width: number;
  height: number;
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
 * Electron closes a detached window when the editor's window closes, and that
 * looks exactly like the user closing it by hand - so quitting the app used to
 * forget which windows were open. A close that comes after this flag is set is
 * the app shutting down, and changes nothing.
 */
let editorClosing = false;
if (typeof window !== 'undefined') {
  const closing = (): void => {
    editorClosing = true;
  };
  window.addEventListener('beforeunload', closing);
  window.addEventListener('pagehide', closing);
}

/** The windows open right now, by name, so the editor can bring one to the front. */
const openWindows = new Map<string, Window>();

/**
 * Brings a detached window to the front - the title bar's list of panels that
 * are out uses it, so a window lost behind others is one click away. False
 * when nothing with that name is open.
 */
export function focusDetachedWindow(name: string): boolean {
  const popout = openWindows.get(name);
  if (!popout || popout.closed) return false;
  // Electron ignores the page's own focus() on another window; the main
  // process raises it (measured: .bench-tmp/focus-probe.mjs).
  if (hasNativeBridge()) window.filmora.focusPanelWindow(name);
  else popout.focus();
  return true;
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
    // A window being torn down reports nothing useful; the last good bounds stay.
    if (popout.closed || popout.outerWidth === 0 || popout.outerHeight === 0) return;
    const bounds: Bounds = {
      width: popout.outerWidth,
      height: popout.outerHeight,
      left: popout.screenX,
      top: popout.screenY,
    };
    window.localStorage.setItem(boundsKey(name), JSON.stringify(bounds));
  } catch {
    // A window that cannot remember where it was still opens.
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

/**
 * The editor's <html> carries state the styles read - the language, and what
 * the motion has to know (motion/environment.ts), such as reduced motion. The
 * detached window carries the same, and follows it when it changes.
 */
function mirrorRoot(target: Document): () => void {
  const copy = (): void => {
    const from = document.documentElement;
    const to = target.documentElement;
    for (const attribute of Array.from(to.attributes)) {
      if (!from.hasAttribute(attribute.name)) to.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(from.attributes)) to.setAttribute(attribute.name, attribute.value);
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(document.documentElement, { attributes: true });
  return () => observer.disconnect();
}

/**
 * Makes the headers along the top of a detached window its title bar.
 *
 * Which headers those are depends on the window: the timeline's carries the
 * mixer beside it, and then both headers touch the top edge but only the
 * mixer's reaches the caption buttons. So rather than guess from the markup,
 * each header that starts at the top of the window is measured: it becomes
 * part of the drag strip (`panel-window-strip` in index.css), and the part of
 * it under Windows' buttons is handed to it as padding (`--caption-room`).
 * The buttons' area comes from the `titlebar-area-*` environment variables
 * Chromium sets under a window-controls overlay - the same ones the editor's
 * title bar reads - with Windows' usual 138px when they are missing.
 */
export function fitTitleStrip(host: HTMLElement): () => void {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => undefined;
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;height:0;visibility:hidden;pointer-events:none;' +
    'left:env(titlebar-area-x, 0px);width:env(titlebar-area-width, calc(100vw - 138px));';
  doc.body.appendChild(probe);

  let frame = 0;
  const fit = (): void => {
    frame = 0;
    const captionLeft = probe.getBoundingClientRect().right;
    for (const header of Array.from(host.querySelectorAll<HTMLElement>('.panel-header'))) {
      const box = header.getBoundingClientRect();
      const onTop = box.height > 0 && box.top <= 1;
      header.classList.toggle('panel-window-strip', onTop);
      // Padding does not move the header's own edges, so this cannot feed back.
      const room = onTop ? Math.max(0, Math.ceil(box.right - captionLeft)) : 0;
      header.style.setProperty('--caption-room', `${room}px`);
    }
  };
  const schedule = (): void => {
    // Through the shared frame source, as every loop is: a window's own
    // requestAnimationFrame starves when that window is minimised.
    if (!frame) frame = requestFrame(fit);
  };
  schedule();
  // A header appears or goes (a clip picked in an empty inspector), the window
  // is resized, or Windows moves its buttons (another display scale).
  const mutations = new MutationObserver(schedule);
  mutations.observe(host, { childList: true, subtree: true });
  const sizes = new ResizeObserver(schedule);
  sizes.observe(host);
  view.addEventListener('resize', schedule);
  const overlay = (view.navigator as Navigator & { windowControlsOverlay?: EventTarget }).windowControlsOverlay;
  overlay?.addEventListener('geometrychange', schedule);
  return () => {
    if (frame) cancelFrame(frame);
    mutations.disconnect();
    sizes.disconnect();
    view.removeEventListener('resize', schedule);
    overlay?.removeEventListener('geometrychange', schedule);
    probe.remove();
  };
}

/**
 * Opens the window and returns its mount host once it is ready. Whatever the
 * caller portals into `host` fills the window edge to edge; `popout` is the
 * window itself, for the tooltip layer that has to draw in it.
 */
export function useDetachedWindow({ name, title, onClose, width, height }: DetachedWindowOptions): {
  host: HTMLElement | null;
  popout: Window | null;
} {
  const [popout, setPopout] = useState<Window | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let teardown: (() => void) | null = null;

    const open = (): void => {
      const bounds = savedBounds(name, { width, height });
      const features = [
        `width=${Math.round(bounds.width)}`,
        `height=${Math.round(bounds.height)}`,
        bounds.left !== undefined ? `left=${Math.round(bounds.left)}` : '',
        bounds.top !== undefined ? `top=${Math.round(bounds.top)}` : '',
      ]
        .filter(Boolean)
        .join(',');

      // The main process allows exactly these `scf-panel-` windows, gives them
      // the editor's caption-button overlay, and tracks each by this name so
      // focusDetachedWindow can raise it (main/index.ts).
      const opened = window.open('about:blank', `scf-panel-${name}`, features);
      if (!opened) {
        onClose();
        return;
      }

      opened.document.title = title;
      copyStyles(opened.document);
      const stopMirroring = mirrorRoot(opened.document);
      // The same ground and text colour as the editor, so a window does not
      // flash white while it opens.
      opened.document.body.className = document.body.className;
      // A column the height of the window, the content stretched over all of it.
      const mount = opened.document.createElement('div');
      mount.className = 'flex h-full w-full flex-col bg-panel-950';
      opened.document.body.appendChild(mount);
      openWindows.set(name, opened);
      // Playback keeps its frames while the editor is minimised and this window
      // is the one on a screen (timing/animationFrame).
      const stopFrames = addFrameWindow(opened);
      setPopout(opened);
      setHost(mount);

      // The editor's shortcuts listen on the main window; a key pressed over a
      // detached window is handed to it, unless a field there is being typed in
      // or something in the window (an open menu) has already used it.
      const forward = (event: KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        // Space from a slider is the transport's, here as in the editor (hooks/spaceFromSlider).
        if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) && !spaceFromSlider(event)) return;
        window.dispatchEvent(new KeyboardEvent(event.type, event));
      };
      opened.addEventListener('keydown', forward);

      const remember = (): void => rememberBounds(name, opened);
      opened.addEventListener('resize', remember);
      const closed = (): void => {
        remember();
        // The app shutting down takes its windows with it; that is not the user
        // closing them, so the layout is left as it is for next time.
        if (!editorClosing) onClose();
      };
      opened.addEventListener('beforeunload', closed);

      teardown = () => {
        remember();
        stopFrames();
        stopMirroring();
        opened.removeEventListener('keydown', forward);
        opened.removeEventListener('resize', remember);
        opened.removeEventListener('beforeunload', closed);
        if (openWindows.get(name) === opened) openWindows.delete(name);
        setHost(null);
        setPopout(null);
        opened.close();
      };
    };

    /*
      Opened in a task of its own, after the editor has laid itself out without
      the window. Measured in this Electron build: a window.open in the same
      task as a layout change makes Chromium drop that change's ResizeObserver
      notifications for good, so whatever the editor sizes by observing - the
      media tabs' highlight, for one - kept the size it had before
      (.bench-tmp/ro-probe.mjs).
    */
    const timer = window.setTimeout(open, 0);
    return () => {
      window.clearTimeout(timer);
      teardown?.();
    };
    // Opened once per window; the title follows in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (host) host.ownerDocument.title = title;
  }, [host, title]);

  useEffect(() => (host ? fitTitleStrip(host) : undefined), [host]);

  return { host, popout };
}
