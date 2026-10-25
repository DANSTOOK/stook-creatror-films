import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Compass, Headphones, Home as HomeIcon, Keyboard, MoreHorizontal, PanelBottom, PanelLeft, PanelRight, Redo2, Search, Settings, Share2, Undo2 } from 'lucide-react';
import type { AppMenuEntry } from '@shared/types/ipc';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT, type MessageKey } from '@renderer/i18n';
// Shared with the palette, so both show the same key beside the same command.
import { acceleratorLabel } from '@renderer/components/CommandPalette/commands';
import { NotificationsButton } from '@renderer/notifications/Toaster';
import { HistoryButton } from '@renderer/history/HistoryButton';
import { WorkspacePicker } from '@renderer/workspaces/WorkspacePicker';
import { DetachedPanelsTray } from '@renderer/components/Layout/DetachedPanelsTray';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { ProjectNameField } from './ProjectNameField';

/**
 * The window's title bar, with the editor's toolbar in it.
 *
 * Windows still draws the minimise, maximise and close buttons (the main
 * process asks for `titleBarOverlay`), so Snap layouts, double-click to
 * maximise and dragging all behave as in any Windows app; everything else in
 * the strip is the page's. It is laid out as CapCut's: at the left the menu,
 * home, Undo, Redo and the history; the project's name in the middle, a
 * click away from being renamed; at the right the workspace, the buttons
 * that show and hide the browser, the timeline and the inspector, the
 * notifications, a "More" menu for the rest (finding a command, the mixer,
 * Preferences, the shortcuts, the tour) and one big Export.
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
  /** Open the command palette - the "search a command" field in the bar. */
  onCommandPalette(): void;
  /** Open the application's Preferences dialog - the gear in the bar. */
  onPreferences(): void;
  nativeAvailable: boolean;
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
  projectPath,
  dirty,
  shown,
  onTogglePanel,
  mixerOpen,
  onMixer,
  onHome,
  onExport,
  onCommandPalette,
  onPreferences,
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

  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** The rest of the bar, in one menu: what is used less often than what stays on it. */
  const openMore = (): void => {
    if (menu) {
      close();
      return;
    }
    const box = moreButton.current?.getBoundingClientRect();
    const invoke = (id: string) => () => (nativeAvailable ? window.filmora.appMenuInvoke(id) : undefined);
    open(
      { preventDefault: () => undefined, clientX: (box?.right ?? 0) - 220, clientY: (box?.bottom ?? 36) + 4 },
      [
        { label: t('titlebar.search'), icon: Search, shortcut: acceleratorLabel('CmdOrCtrl+Shift+P'), onSelect: onCommandPalette },
        { label: t('toolbar.mixer'), icon: Headphones, checked: mixerOpen, onSelect: onMixer },
        { separator: true },
        { label: t('titlebar.settings'), icon: Settings, onSelect: onPreferences },
        { label: t('menu.shortcuts'), icon: Keyboard, shortcut: 'Ctrl+/', onSelect: invoke('shortcuts') },
        { label: t('menu.tour'), icon: Compass, onSelect: invoke('tour') },
      ],
      { label: t('titlebar.more') },
    );
  };

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
      className="app-drag relative flex h-11 shrink-0 items-center gap-1 bg-panel-950 pl-2"
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
        className={`press app-no-drag group flex h-7 items-center gap-1 rounded-control pl-1 pr-1.5 transition-colors duration-150 hover:bg-panel-800 ${
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

          {/* Undo and Redo where CapCut keeps them, by the history they walk. */}
          <div className="app-no-drag flex items-center gap-0.5">
            <button
              type="button"
              data-testid="titlebar-undo"
              className="tool-button w-7 px-0"
              disabled={!canUndo}
              onClick={() => useProjectStore.getState().undo()}
              {...tip(t('titlebar.undo'), { shortcut: 'Ctrl+Z' })}
            >
              <Undo2 size={15} />
            </button>
            <button
              type="button"
              data-testid="titlebar-redo"
              className="tool-button w-7 px-0"
              disabled={!canRedo}
              onClick={() => useProjectStore.getState().redo()}
              {...tip(t('titlebar.redo'), { shortcut: 'Ctrl+Y' })}
            >
              <Redo2 size={15} />
            </button>
            <HistoryButton />
          </div>

          {/* The open project, in the middle, renamed with a click. The rest
              of the strip still drags the window. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex h-full items-center justify-center">
            <div className="pointer-events-auto">
              <ProjectNameField active={active} path={projectPath} dirty={dirty} />
            </div>
          </div>

          <div className="min-w-4 flex-1" />

          {/* Panels that are out in windows of their own, beside the buttons
              for the ones that are here. */}
          <DetachedPanelsTray />

          <div className="app-no-drag mr-1">
            <WorkspacePicker />
          </div>

          <div role="group" aria-label={t('titlebar.panels')} className="toolbar-group app-no-drag">
            {panelToggle('media', PanelLeft, 'Ctrl+1')}
            {panelToggle('timeline', PanelBottom, 'Ctrl+2')}
            {panelToggle('inspector', PanelRight, 'Ctrl+4')}
          </div>

          <span aria-hidden className="mx-1 h-4 w-px bg-panel-700" />

          <div className="app-no-drag">
            <NotificationsButton />
          </div>

          <button
            ref={moreButton}
            type="button"
            data-testid="titlebar-more"
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.label === t('titlebar.more')}
            className="tool-button app-no-drag w-7 px-0"
            onClick={openMore}
            {...tip(t('titlebar.more'), { hint: t('titlebar.moreHint') })}
          >
            <MoreHorizontal size={16} />
          </button>

          <button
            type="button"
            data-testid="titlebar-export"
            className="button-primary app-no-drag ml-1.5 h-[30px] px-5"
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
