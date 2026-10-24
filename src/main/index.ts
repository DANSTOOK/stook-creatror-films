import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, screen, shell, systemPreferences } from 'electron';
import { IPC } from '@shared/types/ipc';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { installAppMenu, menuLanguage } from './appMenu';
import { BACKGROUND, OFF_SCREEN, applyBackgroundSwitches, keepOffScreen } from './background';
import { placePanelWindow } from './panelPlacement';
import { translate } from '@shared/i18n';
import { registerFileSystemHandlers } from './ipc/fileSystem';
import { registerYouTubeHandlers } from './youtube/youtubeIpc';
import { registerSubtitleHandlers } from './subtitles/subtitlesIpc';
import { registerTtsHandlers } from './tts/ttsIpc';
import { logFailedRequests, registerLogHandlers } from './logging/logIpc';
import { registerMattingHandlers } from './matting/mattingIpc';
import type { Transcriber } from './subtitles/transcriber';
import { applyGpuPreferenceAtStartup } from './gpu/gpuSettings';
import { registerMediaProtocolHandler, registerMediaSchemeAsPrivileged } from './ipc/mediaProtocol';
import type { EncoderPipeline } from './exporter/EncoderPipeline';

/**
 * App lifecycle and window management.
 *
 * The renderer runs sandboxed: no Node integration, context isolation on, and
 * every privileged capability reached through the preload bridge.
 */

// The main bundle is emitted as CommonJS into dist-electron/main, so __dirname
// is the reliable anchor here - `import.meta.url` would be polyfilled away.
const DIST_ELECTRON = join(__dirname, '..');
const RENDERER_DIST = join(DIST_ELECTRON, '../dist');
const PRELOAD = join(DIST_ELECTRON, 'preload/preload.js');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
/** The panels' own windows (renderer/components/Layout/PanelWindow), by panel. */
const panelWindows = new Map<string, BrowserWindow>();

/** The page's title bar: its height and colours, for the caption buttons drawn over it. */
const TITLE_BAR_HEIGHT = 40;
/** The bar's colours in each look: panel-950 behind, slate-300 symbols (renderer/theme/palette.css). */
const BAR_COLOURS = {
  dark: { color: '#0e0f11', symbolColor: '#cbd5e1' },
  light: { color: '#e9ecf1', symbolColor: '#334155' },
} as const;

/**
 * The look chosen in Preferences (renderer/theme/theme.ts), kept here too so a
 * window opens in it - not dark, then light a moment later. 'system' follows
 * Windows; it can only, with nativeTheme left to follow it.
 */
type Appearance = { theme: 'dark' | 'light' | 'system'; resolved: 'dark' | 'light' };
const appearanceFile = (): string => join(app.getPath('userData'), 'scf', 'appearance.json');
function savedAppearance(): Appearance {
  try {
    const parsed = JSON.parse(readFileSync(appearanceFile(), 'utf8')) as Partial<Appearance>;
    const theme = parsed.theme === 'light' || parsed.theme === 'system' ? parsed.theme : 'dark';
    const resolved = theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme;
    return { theme, resolved };
  } catch {
    return { theme: 'dark', resolved: 'dark' };
  }
}
let appearance: Appearance = { theme: 'dark', resolved: 'dark' };
const barColours = (): { color: string; symbolColor: string } => BAR_COLOURS[appearance.resolved];
/** A panel's own window has a slimmer bar: it holds a name and one button. */
const PANEL_BAR_HEIGHT = 36;

/**
 * The smallest a panel's window may be made, by panel: about the size at
 * which what the panel has still fits and works - the viewer keeps its
 * transport, the timeline its tools and a couple of tracks - as photographed
 * in the running app at 420x320 (560x320 for the timeline, whose header row
 * needs the room). Anything else gets the default.
 */
const PANEL_MIN_SIZE: Record<string, [number, number]> = {
  viewer: [400, 300],
  timeline: [560, 260],
  media: [320, 300],
  inspector: [320, 300],
  mixer: [360, 300],
};

/** A panel's window opened off every screen goes to the middle of the editor's. */
function keepOnSomeDisplay(window: BrowserWindow, near: BrowserWindow | null): void {
  const bounds = window.getBounds();
  const fallback = (near && !near.isDestroyed() ? screen.getDisplayMatching(near.getBounds()) : screen.getPrimaryDisplay()).workArea;
  const placed = placePanelWindow(bounds, PANEL_BAR_HEIGHT, screen.getAllDisplays().map((display) => display.workArea), fallback);
  if (placed !== bounds) window.setBounds(placed);
}

let pipeline: EncoderPipeline | null = null;
let transcriber: Transcriber | null = null;

/** What the renderer last said about the open project, for the close prompt. */
let documentState = { dirty: false, name: 'Untitled project' };
/** Set once closing has been answered, so the second close goes through. */
let closeApproved = false;

/**
 * A single instance keeps two windows from fighting over the same project file.
 *
 * `app.quit()` only asks the process to stop; this module keeps running, so a
 * second copy went on to build a window anyway. That window loads the page and
 * then never paints, because Chromium is shutting down underneath it - a real
 * window, in the taskbar and in front of anything automating the app, showing
 * nothing and answering no clicks. So the second copy makes no window at all.
 */
const isOnlyInstance = app.requestSingleInstanceLock();
if (!isOnlyInstance) app.quit();

// Chromium reads its switches once, before `ready`. Anything appended later is
// silently ignored - which is where the HEVC switch used to live, inside
// whenReady, doing nothing.
applyGpuPreferenceAtStartup();
applyBackgroundSwitches();
registerMediaSchemeAsPrivileged();
// Hardware video decode keeps scrubbing responsive on large timelines.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

/**
 * Frames are paced to the display's refresh, as they normally would be.
 *
 * This used to be turned off. Back when an export built each frame as a
 * `VideoFrame` from the canvas, that call was gated by vsync - measured on a
 * 180 Hz screen, the export advanced exactly one refresh per frame, pinning an
 * encoder good for 700 fps at 180 - and lifting the gate took a render from
 * 30.7 s to 9.6 s. The cost was that the preview was no longer synchronised to
 * the display and could tear while playing.
 *
 * That gate is gone: the export now decodes forwards through WebCodecs instead
 * of seeking and reading back the canvas. Re-measured on this machine (RTX 4060
 * Laptop, 900 frames of 1080p, three runs each, alternating): 264.2 fps with
 * vsync, 261.3 fps without. The switch buys nothing any more, so the tearing it
 * cost is not worth paying for.
 *
 * SCF_DISABLE_VSYNC brings it back for a machine where it still helps, and
 * `SKIP_SLOW=1 BENCH_SOURCE=<video> tests/bench/run.mjs` is how to check.
 */
if (process.env.SCF_DISABLE_VSYNC) app.commandLine.appendSwitch('disable-gpu-vsync');

/** The system asks for less motion: passed to the page as a switch. */
function reducedMotionArguments(): string[] {
  try {
    const settings = systemPreferences.getAnimationSettings();
    return settings.prefersReducedMotion || !settings.shouldRenderRichAnimation ? ['--scf-reduced-motion'] : [];
  } catch {
    return [];
  }
}

/** True for http: and https: links - the only ones handed to the OS browser. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function createWindow(): void {
  // Native menus, dialogs and scrollbars follow the editor's look, not
  // Windows': a white bar over a dark editor was the brightest thing on
  // screen. 'system' leaves them - and the page's own view of it - to Windows.
  nativeTheme.themeSource = 'system';
  appearance = savedAppearance();
  nativeTheme.themeSource = appearance.theme;
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 960,
    // Narrow windows fold the side panels away rather than crushing the viewer.
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Automated runs happen off-screen and out of the taskbar (background.ts).
    ...(BACKGROUND ? { x: OFF_SCREEN, y: OFF_SCREEN, skipTaskbar: true } : {}),
    backgroundColor: barColours().color,
    title: 'STOOK CREATOR FILMS',
    // The project's own logo in the title bar and taskbar, instead of
    // Electron's. Vite copies public/icon.ico next to index.html.
    icon: join(RENDERER_DIST, 'icon.ico'),
    /*
      The title bar is the page's own, with the toolbar in it, as Final Cut
      does (components/TitleBar). Windows keeps drawing the minimise,
      maximise and close buttons over it - so Snap layouts on the maximise
      button, double-click to maximise and the system menu all still work -
      in the bar's own colours: panel-950 behind, slate-300 symbols.
    */
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...barColours(), height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
      // Windows' own "Animation effects" switch, for the page's motion
      // (renderer/motion/environment.ts): off means fades instead of movement.
      additionalArguments: reducedMotionArguments(),
      // Off-screen and unfocused, a test window must still paint at full rate.
      ...(BACKGROUND ? { backgroundThrottling: false } : {}),
    },
  });

  // In background mode shown without taking the focus, and kept off-screen.
  keepOffScreen(mainWindow);

  /*
    Show the window on whichever comes first, and never more than once.

    The window is created hidden (show: false) and normally revealed on
    'ready-to-show', which arrives with the renderer's first paint. But that
    event can be slow or, in a heavy packaged build, fail to arrive at all -
    and then the app runs with its processes alive but no window on screen,
    which looks exactly like "it won't open". So three triggers race to reveal
    it: the first paint, the page finishing loading, and a safety timer. The
    first to fire shows it; the rest find it already shown and do nothing.
  */
  let revealed = false;
  const reveal = (): void => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    if (BACKGROUND) mainWindow.showInactive();
    else mainWindow.show();
  };
  mainWindow.once('ready-to-show', reveal);
  mainWindow.webContents.once('did-finish-load', reveal);
  // A last resort: if neither event has shown the window a few seconds in,
  // show it anyway rather than leave the app apparently dead.
  setTimeout(reveal, 6000);

  // External links open in the user's browser, never inside the editor shell.
  // Only web links reach the OS: file:, ms-settings: or any other registered
  // protocol handler would let a compromised renderer launch local programs.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (isWebUrl(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    // A panel detached to its own window, for a second monitor. Same origin
    // and same process as the editor, so the panel keeps rendering from the
    // editor's own React tree (components/Layout/PanelWindow.tsx). Only these:
    // anything else a page asks to open is still refused.
    if (url === 'about:blank' && frameName.startsWith('scf-panel-')) {
      const [minWidth, minHeight] = PANEL_MIN_SIZE[frameName.slice('scf-panel-'.length)] ?? [320, 240];
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: barColours().color,
          autoHideMenuBar: true,
          minWidth,
          minHeight,
          icon: join(RENDERER_DIST, 'icon.ico'),
          // The same frame as the editor: the page draws the bar (the panel's
          // name and the way back) and Windows draws its buttons over it.
          titleBarStyle: 'hidden',
          titleBarOverlay: { ...barColours(), height: PANEL_BAR_HEIGHT },
        },
      };
    }
    return { action: 'deny' };
  });

  // A panel's window opens where it was last, if that is still on a screen;
  // automated runs park it off-screen with the editor.
  mainWindow.webContents.on('did-create-window', (window, { frameName }) => {
    if (frameName.startsWith('scf-panel-')) {
      const panel = frameName.slice('scf-panel-'.length);
      panelWindows.set(panel, window);
      window.once('closed', () => {
        if (panelWindows.get(panel) === window) panelWindows.delete(panel);
      });
    }
    if (BACKGROUND) {
      window.setPosition(OFF_SCREEN, OFF_SCREEN, false);
      keepOffScreen(window);
      return;
    }
    keepOnSomeDisplay(window, mainWindow);
  });

  // The editor never navigates. Chromium's default for a file dropped anywhere
  // that does not handle it is to OPEN it - replacing the whole editor with a
  // video player and taking every unsaved edit with it. The renderer swallows
  // stray drops, and this is the backstop if one ever gets through.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (devServerUrl) {
    void mainWindow.loadURL(process.env.SCF_SKIP_HOME ? `${devServerUrl}?start=editor` : devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Automation that drives the editor directly skips the start screen.
    void mainWindow.loadFile(join(RENDERER_DIST, 'index.html'), process.env.SCF_SKIP_HOME ? { query: { start: 'editor' } } : undefined);
  }

  // Unsaved work: ask before the window goes, as every editor does. "Save"
  // hands back to the renderer, which saves (asking where, for a project
  // never saved) and closes only if the save went through. Automation that
  // quits on purpose sets SCF_NO_CLOSE_PROMPT.
  mainWindow.on('close', (event) => {
    if (closeApproved || !documentState.dirty || process.env.SCF_NO_CLOSE_PROMPT) return;
    event.preventDefault();
    const window = mainWindow;
    if (!window) return;
    // In the language the page is in, like the page's own prompt.
    const language = menuLanguage();
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        buttons: [
          translate(language, 'unsaved.save'),
          translate(language, 'unsaved.discard'),
          translate(language, 'dialog.cancel'),
        ],
        defaultId: 0,
        cancelId: 2,
        title: translate(language, 'unsaved.windowTitle'),
        message: translate(language, 'unsaved.title', { name: documentState.name }),
        detail: translate(language, 'unsaved.body'),
      })
      .then(({ response }) => {
        if (response === 2 || window.isDestroyed()) return;
        if (response === 1) {
          closeApproved = true;
          window.close();
          return;
        }
        window.webContents.send(IPC.saveBeforeClose);
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // The copy that lost the lock is on its way out; it must not register
  // handlers or open a window on the way.
  if (!isOnlyInstance) return;

  // The log first: every handler registered after this has its failures written down.
  logFailedRequests();
  registerLogHandlers();
  registerMediaProtocolHandler();
  pipeline = registerFileSystemHandlers(() => mainWindow);
  registerYouTubeHandlers(() => mainWindow);
  transcriber = registerSubtitleHandlers(() => mainWindow);
  registerTtsHandlers(() => mainWindow);
  // An analysis left running stops with the app; what it had half written is
  // swept away at the next start (matting/matteStore.ts).
  const matting = registerMattingHandlers(() => mainWindow);
  app.on('will-quit', () => matting.cancelAll());

  ipcMain.handle(IPC.setAppearance, (_event, theme: unknown, resolved: unknown) => {
    if (theme !== 'dark' && theme !== 'light' && theme !== 'system') return appearance.resolved;
    nativeTheme.themeSource = theme;
    // For 'system' the page asked before Windows' own setting could reach it: this is the answer.
    appearance = { theme, resolved: theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : resolved === 'light' ? 'light' : 'dark' };
    // The caption buttons and their strip, on the editor and every panel's window.
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.setTitleBarOverlay({ ...barColours(), height: window === mainWindow ? TITLE_BAR_HEIGHT : PANEL_BAR_HEIGHT });
        window.setBackgroundColor(barColours().color);
      } catch {
        // A window without the overlay.
      }
    }
    try {
      mkdirSync(join(app.getPath('userData'), 'scf'), { recursive: true });
      writeFileSync(appearanceFile(), JSON.stringify(appearance));
    } catch {
      // Not kept: it applies for this session.
    }
    return appearance.resolved;
  });

  /*
    The user's own project templates: a project kept, with its clips, titles,
    music and settings, to start others from. Kept with the app's data, one
    JSON file each, wrapping the project document with its name and date.
  */
  const templatesFolder = (): string => join(app.getPath('userData'), 'scf', 'templates');
  const templateFile = (id: string): string => {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('Not a template');
    return join(templatesFolder(), `${id}.json`);
  };
  ipcMain.handle(IPC.templatesList, async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const names = await readdir(templatesFolder()).catch(() => [] as string[]);
    const found = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const kept = JSON.parse(await readFile(join(templatesFolder(), name), 'utf8')) as { template?: { name?: string; savedAt?: string }; document?: { project?: { clips?: object; width?: number; height?: number } } };
            const project = kept.document?.project;
            return {
              id: name.slice(0, -5),
              name: String(kept.template?.name ?? name.slice(0, -5)),
              savedAt: String(kept.template?.savedAt ?? ''),
              clips: Object.keys(project?.clips ?? {}).length,
              width: Number(project?.width ?? 0),
              height: Number(project?.height ?? 0),
            };
          } catch {
            return null;
          }
        }),
    );
    return found.filter(Boolean).sort((a, b) => String(b?.savedAt).localeCompare(String(a?.savedAt)));
  });
  ipcMain.handle(IPC.templateSave, async (_event, name: unknown, documentJson: unknown) => {
    if (typeof name !== 'string' || !name.trim() || typeof documentJson !== 'string') throw new Error('Nothing to keep');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    await mkdir(templatesFolder(), { recursive: true });
    const id = randomUUID();
    await writeFile(templateFile(id), JSON.stringify({ template: { name: name.trim().slice(0, 120), savedAt: new Date().toISOString() }, document: JSON.parse(documentJson) }));
    return id;
  });
  ipcMain.handle(IPC.templateRead, async (_event, id: unknown) => {
    const { readFile } = await import('node:fs/promises');
    const kept = JSON.parse(await readFile(templateFile(String(id)), 'utf8')) as { document: unknown };
    return JSON.stringify(kept.document);
  });
  ipcMain.handle(IPC.templateDelete, async (_event, id: unknown) => {
    const { rm } = await import('node:fs/promises');
    await rm(templateFile(String(id)), { force: true });
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.on(IPC.documentState, (_event, state: unknown) => {
    if (!state || typeof state !== 'object') return;
    const { dirty, name } = state as { dirty?: unknown; name?: unknown };
    documentState = { dirty: dirty === true, name: typeof name === 'string' && name ? name : 'Untitled project' };
  });

  // The full-screen viewer takes the whole screen, not just the window, as
  // Final Cut's Play Full Screen and Resolve's Cinema Viewer do.
  ipcMain.on(IPC.windowFullScreen, (_event, on: unknown) => {
    // Not in background mode: full screen would put the window on a display.
    if (mainWindow && !mainWindow.isDestroyed() && !BACKGROUND) mainWindow.setFullScreen(on === true);
  });

  ipcMain.on(IPC.focusPanelWindow, (_event, panel: unknown) => {
    const window = typeof panel === 'string' ? panelWindows.get(panel) : undefined;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  ipcMain.handle(IPC.closeAfterSave, () => {
    closeApproved = true;
    mainWindow?.close();
  });
  // Before the window: the default menu - with Reload on Ctrl+R - must never
  // be the one it starts with.
  installAppMenu(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  // A second launch must always leave a usable window on screen. The first
  // copy holds the single-instance lock, so this copy quit at once; it is
  // this handler that has to surface the window. If the first copy still has
  // one, raise it; if its window was closed but the process lingered, make a
  // new one. Without the last case the app looks unlaunchable - every
  // double-click does nothing - until the stray process is killed by hand.
  if (BACKGROUND) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  // A running encoder holds a child process; kill it before the app exits.
  // So does a transcription: its process goes, and its temporary sound with it.
  if (pipeline || transcriber) {
    event.preventDefault();
    const current = pipeline;
    const jobs = transcriber;
    pipeline = null;
    transcriber = null;
    await Promise.all([current?.disposeAll(), jobs?.cancelAll()]);
    app.quit();
  }
});
