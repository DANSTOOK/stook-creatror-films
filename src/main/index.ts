import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { IPC } from '@shared/types/ipc';
import { join } from 'node:path';
import { installAppMenu, menuLanguage } from './appMenu';
import { translate } from '@shared/i18n';
import { registerFileSystemHandlers } from './ipc/fileSystem';
import { registerYouTubeHandlers } from './youtube/youtubeIpc';
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

/** The page's title bar: its height and colours, for the caption buttons drawn over it. */
const TITLE_BAR_HEIGHT = 40;
const TITLE_BAR_COLOR = '#0e0f11';
const TITLE_BAR_SYMBOLS = '#cbd5e1';
let pipeline: EncoderPipeline | null = null;

/** What the renderer last said about the open project, for the close prompt. */
let documentState = { dirty: false, name: 'Untitled project' };
/** Set once closing has been answered, so the second close goes through. */
let closeApproved = false;

// A single instance keeps two windows from fighting over the same project file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Chromium reads its switches once, before `ready`. Anything appended later is
// silently ignored - which is where the HEVC switch used to live, inside
// whenReady, doing nothing.
applyGpuPreferenceAtStartup();
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

function createWindow(): void {
  // The editor is dark whatever Windows is set to: native menus, dialogs and
  // scrollbars follow this. A white bar over a dark editor was the brightest
  // thing on screen.
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 960,
    minWidth: 1180,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d0f14',
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
    titleBarOverlay: { color: TITLE_BAR_COLOR, symbolColor: TITLE_BAR_SYMBOLS, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the user's browser, never inside the editor shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
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
  registerMediaProtocolHandler();
  pipeline = registerFileSystemHandlers(() => mainWindow);
  registerYouTubeHandlers(() => mainWindow);

  ipcMain.on(IPC.documentState, (_event, state: unknown) => {
    if (!state || typeof state !== 'object') return;
    const { dirty, name } = state as { dirty?: unknown; name?: unknown };
    documentState = { dirty: dirty === true, name: typeof name === 'string' && name ? name : 'Untitled project' };
  });

  // The full-screen viewer takes the whole screen, not just the window, as
  // Final Cut's Play Full Screen and Resolve's Cinema Viewer do.
  ipcMain.on(IPC.windowFullScreen, (_event, on: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(on === true);
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
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  // A running encoder holds a child process; kill it before the app exits.
  if (pipeline) {
    event.preventDefault();
    const current = pipeline;
    pipeline = null;
    await current.disposeAll();
    app.quit();
  }
});
