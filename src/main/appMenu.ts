import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';
import { translate, type MessageKey } from '@shared/i18n';
import { IPC, type AppMenuEntry, type MenuCommand, type MenuState } from '@shared/types/ipc';

/**
 * The application menu.
 *
 * It replaces Electron's default menu, which is a developer's menu, not an
 * editor's: its View > Reload sat on Ctrl+R - this app's Speed key - and
 * threw the whole editor away with every unsaved edit, from anywhere,
 * including inside a text field. Force reload, DevTools and page zoom came
 * with it.
 *
 * Two rules keep it from ever doing that again:
 *
 * - Every item that is one of the editor's own actions only NAMES the action
 *   (IPC.menuCommand) and the page runs it, with the same code as its button.
 * - The page owns its keys. Where an item has a shortcut, the menu shows it
 *   but does not register it (`registerAccelerator: false`, Windows and
 *   Linux): the page's own handler already runs it, knows about text fields,
 *   selections and dialogs, and a second binding here would run it twice or
 *   run it where the page decided not to.
 *
 * The page reports its state (IPC.menuState) - language, what is showing,
 * whether there is anything to undo - and the menu is rebuilt from it.
 */

const APP_NAME = 'STOOK CREATOR FILMS';

const INITIAL: MenuState = {
  language: 'en',
  editor: false,
  canUndo: false,
  canRedo: false,
  mediaShown: true,
  inspectorShown: true,
  timelineShown: true,
  fullscreenViewer: false,
};

/** The menu for a given page state. Pure apart from the callbacks it closes over. */
export function buildMenuTemplate(
  state: MenuState,
  send: (command: MenuCommand) => void,
  options: { devTools: boolean; about: () => void; window: () => BrowserWindow | null },
): MenuItemConstructorOptions[] {
  const t = (key: MessageKey, params?: Record<string, string>): string => translate(state.language, key, params);
  const inEditor = state.editor;

  /** An item that asks the page to do something, with its key shown but left to the page. */
  const command = (
    key: MessageKey,
    name: MenuCommand,
    extra: Partial<MenuItemConstructorOptions> = {},
  ): MenuItemConstructorOptions => ({
    // The id is the command: the page's own menu clicks items by it.
    id: name,
    label: t(key),
    click: () => send(name),
    ...(extra.accelerator ? { registerAccelerator: false } : {}),
    ...extra,
  });

  const file: MenuItemConstructorOptions = {
    label: t('menu.file'),
    submenu: [
      command('menu.new', 'new', { accelerator: 'CmdOrCtrl+N' }),
      command('menu.open', 'open', { accelerator: 'CmdOrCtrl+O' }),
      { type: 'separator' },
      command('menu.save', 'save', { accelerator: 'CmdOrCtrl+S', enabled: inEditor }),
      command('menu.saveAs', 'saveAs', { accelerator: 'CmdOrCtrl+Shift+S', enabled: inEditor }),
      { type: 'separator' },
      command('menu.import', 'import', { accelerator: 'CmdOrCtrl+I', enabled: inEditor }),
      command('menu.export', 'export', { accelerator: 'CmdOrCtrl+E', enabled: inEditor }),
      { type: 'separator' },
      command('menu.projectSettings', 'projectSettings', { enabled: inEditor }),
      { type: 'separator' },
      command('menu.home', 'home', { enabled: inEditor }),
      // Quitting goes through the window's close, so unsaved work is asked about.
      { id: 'exit', label: t('menu.exit'), accelerator: 'Alt+F4', registerAccelerator: false, click: () => app.quit() },
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: t('menu.edit'),
    submenu: [
      command('menu.undo', 'undo', { accelerator: 'CmdOrCtrl+Z', enabled: inEditor && state.canUndo }),
      // Ctrl+Shift+Z works as well; the menu can show only one key.
      command('menu.redo', 'redo', { accelerator: 'CmdOrCtrl+Y', enabled: inEditor && state.canRedo }),
      { type: 'separator' },
      // Clips on the timeline, or the text in a field when one has focus.
      command('menu.cut', 'cut', { accelerator: 'CmdOrCtrl+X' }),
      command('menu.copy', 'copy', { accelerator: 'CmdOrCtrl+C' }),
      command('menu.paste', 'paste', { accelerator: 'CmdOrCtrl+V' }),
      { type: 'separator' },
      // Where Windows editors keep them (Premiere: Edit > Preferences).
      command('menu.preferences', 'preferences'),
    ],
  };

  // Show and hide belong in View, as the HIG puts them; the ticks say what is showing.
  const view: MenuItemConstructorOptions = {
    label: t('menu.view'),
    submenu: [
      // The keys Final Cut gives its browser, timeline and inspector buttons.
      command('menu.showMedia', 'toggleMedia', {
        type: 'checkbox',
        checked: state.mediaShown,
        accelerator: 'CmdOrCtrl+1',
        enabled: inEditor,
      }),
      command('menu.showTimeline', 'toggleTimeline', {
        type: 'checkbox',
        checked: state.timelineShown,
        accelerator: 'CmdOrCtrl+2',
        enabled: inEditor,
      }),
      command('menu.showInspector', 'toggleInspector', {
        type: 'checkbox',
        checked: state.inspectorShown,
        accelerator: 'CmdOrCtrl+4',
        enabled: inEditor,
      }),
      { type: 'separator' },
      command('menu.fullscreenViewer', 'fullscreenViewer', {
        type: 'checkbox',
        checked: state.fullscreenViewer,
        accelerator: 'Shift+F',
        enabled: inEditor,
      }),
      { type: 'separator' },
      command('menu.resetLayout', 'resetLayout', { enabled: inEditor }),
      // For whoever is working on the app itself; never in a packaged build.
      ...(options.devTools
        ? [
            { type: 'separator' } as MenuItemConstructorOptions,
            {
              id: 'devTools',
              label: t('menu.devTools'),
              accelerator: 'F12',
              click: () => options.window()?.webContents.toggleDevTools(),
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  };

  const window: MenuItemConstructorOptions = {
    label: t('menu.window'),
    submenu: [
      command('menu.mixer', 'mixer', { enabled: inEditor }),
      { type: 'separator' },
      // Plain clicks rather than roles: the roles bring keys of their own
      // (Ctrl+M, Ctrl+W) that nobody asked for and that are one slip away.
      { id: 'minimize', label: t('menu.minimize'), click: () => options.window()?.minimize() },
      {
        id: 'close',
        label: t('menu.close'),
        accelerator: 'Alt+F4',
        registerAccelerator: false,
        click: () => options.window()?.close(),
      },
    ],
  };

  const help: MenuItemConstructorOptions = {
    label: t('menu.help'),
    submenu: [
      command('menu.shortcuts', 'shortcuts', { accelerator: 'Shift+/', enabled: inEditor }),
      { type: 'separator' },
      { id: 'about', label: t('menu.about', { app: APP_NAME }), click: options.about },
    ],
  };

  return [file, edit, view, window, help];
}

/**
 * Install the menu and keep it in step with the page. Call once, when the app
 * is ready and before the first window exists, so the default menu is never
 * the one a window starts with.
 */
/** The language the page last reported, for anything else the main process says. */
let reportedLanguage: MenuState['language'] = 'en';
export const menuLanguage = (): MenuState['language'] => reportedLanguage;

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  let state: MenuState = INITIAL;
  let applied = '';

  const send = (command: MenuCommand): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.menuCommand, command);
  };

  const about = (): void => {
    const window = getWindow();
    const options = {
      type: 'info' as const,
      title: translate(state.language, 'menu.about', { app: APP_NAME }),
      message: APP_NAME,
      detail: translate(state.language, 'menu.aboutDetail', { version: app.getVersion() }),
    };
    void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  };

  const apply = (): void => {
    const key = JSON.stringify(state);
    if (key === applied) return;
    applied = key;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(state, send, { devTools: !app.isPackaged, about, window: getWindow })));
  };

  ipcMain.on(IPC.menuState, (_event, next: unknown) => {
    if (!next || typeof next !== 'object') return;
    const raw = next as Partial<Record<keyof MenuState, unknown>>;
    state = {
      language: raw.language === 'es' ? 'es' : 'en',
      editor: raw.editor === true,
      canUndo: raw.canUndo === true,
      canRedo: raw.canRedo === true,
      mediaShown: raw.mediaShown !== false,
      inspectorShown: raw.inspectorShown !== false,
      timelineShown: raw.timelineShown !== false,
      fullscreenViewer: raw.fullscreenViewer === true,
    };
    reportedLanguage = state.language;
    apply();
  });

  // Cut, copy and paste inside a text field, which the page cannot do on its own.
  ipcMain.on(IPC.editText, (event, operation: unknown) => {
    const contents = event.sender;
    if (operation === 'cut') contents.cut();
    else if (operation === 'copy') contents.copy();
    else if (operation === 'paste') contents.paste();
  });

  // The page draws this same menu in its title bar (there is no native menu
  // bar under a custom title bar), and picks from it by id.
  ipcMain.handle(IPC.appMenuModel, () => serializeMenu(Menu.getApplicationMenu()));
  ipcMain.on(IPC.appMenuInvoke, (_event, id: unknown) => {
    if (typeof id !== 'string') return;
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item || !item.enabled || !item.click) return;
    item.click();
  });

  apply();
}

/** The menu as plain data, for the page to draw. */
export function serializeMenu(menu: Menu | null): AppMenuEntry[] {
  if (!menu) return [];
  return menu.items
    .filter((item) => item.visible)
    .map((item): AppMenuEntry => {
      const type: AppMenuEntry['type'] =
        item.type === 'separator' ? 'separator' : item.type === 'checkbox' ? 'checkbox' : item.submenu ? 'submenu' : 'normal';
      return {
        ...(item.id ? { id: item.id } : {}),
        // "&File" underlines F under Alt in a native menu bar; the page's
        // menu opens from its button and the arrow keys instead.
        label: item.label.replace(/&(.)/g, '$1'),
        type,
        ...(item.accelerator ? { accelerator: String(item.accelerator) } : {}),
        enabled: item.enabled,
        ...(type === 'checkbox' ? { checked: item.checked } : {}),
        ...(item.submenu ? { submenu: serializeMenu(item.submenu) } : {}),
      };
    });
}
