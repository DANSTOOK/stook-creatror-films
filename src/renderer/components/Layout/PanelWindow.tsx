import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft } from 'lucide-react';
import { TooltipLayer, tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import type { DetachablePanel } from '@renderer/store/useWorkspaceStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { PANEL_ICON, PANEL_NAME } from './panelInfo';

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
 * at any size, under a bar drawn like the editor's own title bar (the main
 * process gives these windows the same caption-button overlay). The bar names
 * the panel - the viewer's header shows the project's name, not "Viewer" -
 * and says in words how to put it back, which Premiere leaves to dragging a
 * tab and a menu nobody finds.
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

/** The window's own bar: what the panel is, and the way back. */
function PanelWindowBar({ panel, onDock }: { panel: DetachablePanel; onDock(): void }): JSX.Element {
  const t = useT();
  const Icon = PANEL_ICON[panel];
  return (
    <header
      data-testid={`panel-window-bar-${panel}`}
      className="app-drag flex h-9 shrink-0 items-center gap-2 bg-panel-950 pl-3"
      style={{
        // The caption buttons' room, as in the editor's title bar.
        paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)) + 8px)',
      }}
    >
      <Icon size={14} aria-hidden className="shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-200">{t(PANEL_NAME[panel])}</span>
      <button
        type="button"
        data-testid={`dock-${panel}`}
        className="tool-button tool-button-dense app-no-drag shrink-0"
        onClick={onDock}
        {...tip(t('panel.dock'), { named: false })}
      >
        <PanelsTopLeft size={13} aria-hidden />
        {/* Words while there is room; a narrow window keeps the icon, and the
            name stays for a screen reader. */}
        <span className="max-[439px]:sr-only">{t('panel.dockShort')}</span>
      </button>
    </header>
  );
}

export function PanelWindow({ panel, onClose, children, width = 900, height = 620 }: PanelWindowProps): JSX.Element | null {
  const t = useT();
  const [popout, setPopout] = useState<Window | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const title = t('panel.windowTitle', { name: t(PANEL_NAME[panel]) });

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
      // A column the height of the window: the bar, then the panel stretched
      // over everything left. The panel's own box is what fills - a block mount
      // let each panel take the height of its content, which left the inspector
      // a strip at the top of an empty window and pushed the viewer's transport
      // off the bottom.
      const mount = opened.document.createElement('div');
      mount.className = 'flex h-full w-full flex-col bg-panel-950';
      opened.document.body.appendChild(mount);
      openWindows.set(panel, opened);
      setPopout(opened);
      setHost(mount);

      // The editor's shortcuts listen on the main window; a key pressed over a
      // detached panel is handed to it, unless a field there is being typed in
      // or something in the panel's window (an open menu) has already used it.
      const forward = (event: KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
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

  if (!host || !popout) return null;
  return createPortal(
    <>
      <PanelWindowBar panel={panel} onDock={onClose} />
      {/* Whatever panel is put here fills it, including one (the mixer) that
          takes only the width of its content when docked. */}
      <div data-testid={`panel-window-${panel}`} className="flex min-h-0 min-w-0 flex-1 px-1.5 pb-1.5 [&>*]:min-w-0 [&>*]:flex-1">
        {children}
      </div>
      {/* Tips for the controls in this window, drawn in this window. */}
      <TooltipLayer view={popout} />
    </>,
    host,
  );
}

export default PanelWindow;
