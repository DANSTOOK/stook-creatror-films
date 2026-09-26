import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Headphones, Home as HomeIcon, PanelBottom, PanelLeft, PanelRight, Share2 } from 'lucide-react';
import type { AppMenuEntry } from '@shared/types/ipc';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { keyLabel, useT, type MessageKey } from '@renderer/i18n';
import { NotificationsButton } from '@renderer/notifications/Toaster';

/**
 * The window's title bar, with the editor's toolbar in it.
 *
 * Windows still draws the minimise, maximise and close buttons (the main
 * process asks for `titleBarOverlay`), so Snap layouts, double-click to
 * maximise and dragging all behave as in any Windows app; everything else in
 * the strip is the page's. It follows Final Cut's toolbar: what you are
 * working on at the left, nothing in the middle, and at the right the buttons
 * that show and hide the browser, the timeline and the inspector, then Share.
 * New, Open, Save, Undo and Redo left the bar: they are in the menu and on
 * the keys every editor uses for them.
 *
 * Empty parts of the strip drag the window (`app-drag`), and every control in
 * it opts out (`app-no-drag`) or it could not be clicked. The strip leaves the
 * caption buttons their room through the `titlebar-area-*` environment
 * variables Chromium sets under a window-controls overlay.
 *
 * The native menu bar cannot sit under a custom title bar, so the app icon is
 * the menu button: it shows the very same menu (read from the main process,
 * clicked by id), and Alt or F10 opens it from the keyboard, as they would
 * open a Windows menu bar.
 */

export type PanelKey = 'media' | 'timeline' | 'inspector';

export interface TitleBarProps {
  /** The editor, or the start screen - which keeps only the menu and the name. */
  editor: boolean;
  logoUrl: string;
  projectName: string;
  projectPath: string | null;
  dirty: boolean;
  shown: Record<PanelKey, boolean>;
  onTogglePanel(panel: PanelKey): void;
  mixerOpen: boolean;
  onMixer(): void;
  onHome(): void;
  onExport(): void;
  nativeAvailable: boolean;
}

/** An Electron accelerator as the keys read in this language: "CmdOrCtrl+Shift+S" to "Ctrl+Mayús+S". */
function acceleratorLabel(accelerator: string | undefined): string | undefined {
  if (!accelerator) return undefined;
  const plain = accelerator.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/^Shift\+\/$/, '?');
  return keyLabel(plain);
}

/** The main process's menu as the page's menu items, each clicking the real item by id. */
function toItems(entries: AppMenuEntry[]): ContextMenuItem[] {
  return entries.map((entry): ContextMenuItem => {
    if (entry.type === 'separator') return { separator: true };
    return {
      label: entry.label,
      disabled: !entry.enabled,
      shortcut: acceleratorLabel(entry.accelerator),
      ...(entry.type === 'checkbox' ? { checked: Boolean(entry.checked) } : {}),
      ...(entry.submenu ? { submenu: toItems(entry.submenu) } : {}),
      onSelect: entry.id ? () => window.filmora.appMenuInvoke(entry.id as string) : undefined,
    };
  });
}

export function TitleBar({
  editor,
  logoUrl,
  projectName,
  projectPath,
  dirty,
  shown,
  onTogglePanel,
  mixerOpen,
  onMixer,
  onHome,
  onExport,
  nativeAvailable,
}: TitleBarProps): JSX.Element {
  const t = useT();
  const { menu, open, close } = useContextMenu();
  const menuButton = useRef<HTMLButtonElement>(null);
  // An inactive window reads quieter, as the HIG asks: its title dims.
  const [active, setActive] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()));

  useEffect(() => {
    const on = (): void => setActive(true);
    const off = (): void => setActive(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);

  const openMenu = useCallback(
    async (keyboard: boolean) => {
      if (!nativeAvailable) return;
      const entries = await window.filmora.appMenuModel();
      const box = menuButton.current?.getBoundingClientRect();
      open(
        { preventDefault: () => undefined, clientX: box?.left ?? 8, clientY: (box?.bottom ?? 36) + 4 },
        toItems(entries),
        { keyboard, label: t('titlebar.appMenu') },
      );
    },
    [nativeAvailable, open, t],
  );

  // Alt pressed and released on its own, or F10, opens the menu - what they
  // do to a menu bar in any Windows app. Alt is also a modifier here (Alt+
  // click, Alt+drag), so anything pressed or clicked in between cancels it.
  useEffect(() => {
    let armed = false;
    const modalOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Alt' && !event.repeat && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
        armed = true;
        return;
      }
      armed = false;
      if (event.key === 'F10' && !event.altKey && !event.ctrlKey && !event.shiftKey && !modalOpen()) {
        event.preventDefault();
        void openMenu(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== 'Alt' || !armed) return;
      armed = false;
      if (modalOpen() || menu) return;
      event.preventDefault();
      void openMenu(true);
    };
    const disarm = (): void => {
      armed = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('pointermove', disarm, true);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('pointermove', disarm, true);
      window.removeEventListener('blur', disarm);
    };
  }, [menu, openMenu]);

  const panelToggle = (panel: PanelKey, Icon: typeof PanelLeft, shortcut: string): JSX.Element => (
    <button
      type="button"
      data-testid={`toggle-${panel}`}
      aria-pressed={shown[panel]}
      className={`tool-button app-no-drag w-7 px-0 ${shown[panel] ? 'text-slate-100' : 'text-slate-400'}`}
      onClick={() => onTogglePanel(panel)}
      {...tip(t(`titlebar.${panel}` as MessageKey), { shortcut, hint: t(`titlebar.${panel}Hint` as MessageKey) })}
    >
      <Icon size={15} strokeWidth={shown[panel] ? 2 : 1.6} className={shown[panel] ? '' : 'opacity-80'} />
    </button>
  );

  return (
    <header
      data-testid="title-bar"
      data-active={active}
      className="app-drag relative flex h-10 shrink-0 items-center gap-1 bg-panel-950 pl-2"
      style={{
        // The caption buttons' room: whatever the overlay leaves to the page.
        paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)) + 8px)',
      }}
    >
      <button
        ref={menuButton}
        type="button"
        data-testid="app-menu-button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        disabled={!nativeAvailable}
        className={`app-no-drag group flex h-7 items-center gap-1 rounded-control pl-1 pr-1.5 transition-colors duration-150 hover:bg-panel-800 ${
          menu ? 'bg-panel-800' : ''
        }`}
        onClick={() => (menu ? close() : void openMenu(false))}
        {...tip(t('titlebar.menu'), { shortcut: 'Alt' })}
      >
        {/* The project logo. It has its own light ground, so it sits in a
            rounded tile rather than being cut out against the dark bar. */}
        <img src={logoUrl} alt="" className="h-5 w-5 rounded-[5px]" draggable={false} />
        <ChevronDown size={12} className="text-slate-400 transition-colors group-hover:text-slate-200" />
      </button>

      {editor ? (
        <>
          <button
            type="button"
            className="tool-button app-no-drag w-7 px-0"
            onClick={onHome}
            {...tip(t('toolbar.home'), { hint: t('toolbar.homeHint') })}
          >
            <HomeIcon size={15} />
          </button>

          <span aria-hidden className="mx-1 h-4 w-px bg-panel-700" />

          {/* The open project, and whether it has unsaved changes. Part of
              the drag area, as a window title is. */}
          <div className="flex min-w-0 items-center gap-2 px-1" title={projectPath ?? t('toolbar.notSaved')}>
            <span
              data-testid="project-name"
              className={`truncate text-sm font-semibold transition-colors ${active ? 'text-slate-100' : 'text-slate-400'}`}
            >
              {projectName}
            </span>
            {dirty && (
              <span
                data-testid="unsaved-indicator"
                role="img"
                aria-label={t('toolbar.unsaved')}
                className="scf-dirty-dot h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                title={t('toolbar.unsaved')}
              />
            )}
          </div>

          <div className="min-w-4 flex-1" />

          <div role="group" aria-label={t('titlebar.panels')} className="flex items-center gap-0.5">
            {panelToggle('media', PanelLeft, 'Ctrl+1')}
            {panelToggle('timeline', PanelBottom, 'Ctrl+2')}
            {panelToggle('inspector', PanelRight, 'Ctrl+4')}
          </div>

          <span aria-hidden className="mx-1 h-4 w-px bg-panel-700" />

          <button
            type="button"
            aria-pressed={mixerOpen}
            className={`tool-button app-no-drag w-7 px-0 ${mixerOpen ? 'tool-button-active' : ''}`}
            onClick={onMixer}
            {...tip(t('toolbar.mixer'), { hint: t('toolbar.mixerHint') })}
          >
            <Headphones size={15} />
          </button>

          <div className="app-no-drag">
            <NotificationsButton />
          </div>

          <button
            type="button"
            className="button-primary app-no-drag ml-1 h-control"
            disabled={!nativeAvailable}
            onClick={onExport}
            {...tip(t('toolbar.export'), {
              shortcut: 'Ctrl+E',
              hint: nativeAvailable ? t('toolbar.exportHint') : t('toolbar.exportDesktopOnly'),
              named: false,
            })}
          >
            <Share2 size={14} />
            {t('toolbar.export')}
          </button>
        </>
      ) : (
        <div className="flex-1" />
      )}

      {menu && <ContextMenu {...menu} onClose={close} />}
    </header>
  );
}

export default TitleBar;
