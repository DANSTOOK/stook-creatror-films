import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TooltipLayer } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import type { DetachablePanel } from '@renderer/store/useWorkspaceStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { addFrameWindow, cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { spaceFromSlider } from '@renderer/hooks/spaceFromSlider';
import { PANEL_NAME } from './panelInfo';
import { PanelWindowContext, type PanelWindowScope } from './panelWindowContext';

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
 *
 * The window is the panel and nothing else: the panel fills it edge to edge
 * at any size, and the panel's own header is the window's title bar. It used
 * to sit under a bar of the window's own that named the panel a second time -
 * 72px of chrome, half of it saying the same thing twice. Now the header
 * drags the window, its controls stay clickable, and its right end leaves
 * room for the minimise, maximise and close buttons Windows draws over it
 * (the main process gives these windows the same caption-button overlay as
 * the editor). The way back is the header's own detach button, turned round:
 * "Back to editor", in words, where the panel was sent out from - which
 * Premiere leaves to dragging a tab and a menu nobody finds. The window's
 * title still names the panel for the taskbar and Alt+Tab.
 */

export interface PanelWindowProps {
  panel: DetachablePanel;
  /** The window was closed, or "Back to editor" pressed: the panel goes back. */
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

/** The windows open right now, so the editor can bring one to the front. */
const openWindows = new Map<DetachablePanel, Window>();

/**
 * Brings a detached panel's window to the front - the title bar's list of
 * panels that are out uses it, so a window lost behind others is one click
 * away. False when the panel has no window open.
 */
export function focusPanelWindow(panel: DetachablePanel): boolean {
  const popout = openWindows.get(panel);
  if (!popout || popout.closed) return false;
  // Electron ignores the page's own focus() on another window; the main
  // process raises it (measured: .bench-tmp/focus-probe.mjs).
  if (hasNativeBridge()) window.filmora.focusPanelWindow(panel);
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

/**
 * The editor's <html> carries state the styles read - the language, and what
 * the motion has to know (motion/environment.ts), such as reduced motion. The
 * panel's window carries the same, and follows it when it changes.
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
 * Makes the headers along the top of a panel's window its title bar.
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
function fitTitleStrip(host: HTMLElement): () => void {
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

export function PanelWindow({ panel, onClose, children, width = 900, height = 620 }: PanelWindowProps): JSX.Element | null {
  const t = useT();
  const [popout, setPopout] = useState<Window | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const title = t('panel.windowTitle', { name: t(PANEL_NAME[panel]) });
  const scope = useMemo<PanelWindowScope>(() => ({ panel, dock: onClose }), [panel, onClose]);

  useEffect(() => {
    let teardown: (() => void) | null = null;

    const open = (): void => {
      const bounds = savedBounds(panel, { width, height });
      const features = [
        `width=${Math.round(bounds.width)}`,
        `height=${Math.round(bounds.height)}`,
        bounds.left !== undefined ? `left=${Math.round(bounds.left)}` : '',
        bounds.top !== undefined ? `top=${Math.round(bounds.top)}` : '',
      ]
        .filter(Boolean)
        .join(',');

      const opened = window.open('about:blank', `scf-panel-${panel}`, features);
      if (!opened) {
        onClose();
        return;
      }

      opened.document.title = title;
      copyStyles(opened.document);
      const stopMirroring = mirrorRoot(opened.document);
      // The same ground and text colour as the editor, so a panel does not flash
      // white while it opens.
      opened.document.body.className = document.body.className;
      // A column the height of the window, the panel stretched over all of
      // it. The panel's own box is what fills - a block mount
      // let each panel take the height of its content, which left the inspector
      // a strip at the top of an empty window and pushed the viewer's transport
      // off the bottom.
      const mount = opened.document.createElement('div');
      mount.className = 'flex h-full w-full flex-col bg-panel-950';
      opened.document.body.appendChild(mount);
      openWindows.set(panel, opened);
      // Playback keeps its frames while the editor is minimised and this
      // window is the one on a screen (timing/animationFrame).
      const stopFrames = addFrameWindow(opened);
      setPopout(opened);
      setHost(mount);

      // The editor's shortcuts listen on the main window; a key pressed over a
      // detached panel is handed to it, unless a field there is being typed in
      // or something in the panel's window (an open menu) has already used it.
      const forward = (event: KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        // Space from a slider is the transport's, here as in the editor (hooks/spaceFromSlider).
        if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) && !spaceFromSlider(event)) return;
        window.dispatchEvent(new KeyboardEvent(event.type, event));
      };
      opened.addEventListener('keydown', forward);

      const remember = (): void => rememberBounds(panel, opened);
      opened.addEventListener('resize', remember);
      const closed = (): void => {
        remember();
        // The app shutting down takes its panel windows with it; that is not the
        // user docking them, so the layout is left as it is for next time.
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
        if (openWindows.get(panel) === opened) openWindows.delete(panel);
        setHost(null);
        setPopout(null);
        opened.close();
      };
    };

    /*
      Opened in a task of its own, after the editor has laid itself out without
      the panel. Measured in this Electron build: a window.open in the same task
      as a layout change makes Chromium drop that change's ResizeObserver
      notifications for good, so whatever the editor sizes by observing - the
      media tabs' highlight, for one - kept the size it had before the panel
      left (.bench-tmp/ro-probe.mjs).
    */
    const timer = window.setTimeout(open, 0);
    return () => {
      window.clearTimeout(timer);
      teardown?.();
    };
    // Opened once per detached panel; the title follows in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  useEffect(() => {
    if (host) host.ownerDocument.title = title;
  }, [host, title]);

  useEffect(() => (host ? fitTitleStrip(host) : undefined), [host]);

  if (!host || !popout) return null;
  return createPortal(
    <PanelWindowContext.Provider value={scope}>
      {/* Whatever panel is put here fills it, including one (the mixer) that
          takes only the width of its content when docked. Edge to edge: the
          window's frame is the panel's frame (`panel-window` in index.css). */}
      <div data-testid={`panel-window-${panel}`} className="panel-window flex min-h-0 min-w-0 flex-1 [&>*]:min-w-0 [&>*]:flex-1">
        {children}
      </div>
      {/* Tips for the controls in this window, drawn in this window. */}
      <TooltipLayer view={popout} />
    </PanelWindowContext.Provider>,
    host,
  );
}

export default PanelWindow;
