import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerFileSystemHandlers } from './ipc/fileSystem';
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
let pipeline: EncoderPipeline | null = null;

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
 * Do not pace the compositor to the display's refresh.
 *
 * An export builds each frame as a `VideoFrame` from the canvas, and that
 * call is gated by vsync: measured on a 180 Hz screen, the whole export
 * advanced exactly one refresh per frame - 5.555 ms, or 11.111 ms when a
 * frame slipped the deadline, never anything in between - which pinned an
 * encoder good for 700 fps at 180. Lifting it took the same render from
 * 30.7 s to 9.6 s, with every exported frame still the right picture.
 *
 * The cost is that the preview is no longer synchronised to the display and
 * can tear while playing. Reading the pixels back to dodge the gate instead
 * was tried and measured slower (see WebCodecsEncoder), and
 * `disable-frame-rate-limit` is worse still - it lets the viewport's own
 * animation loop spin free.
 */
app.commandLine.appendSwitch('disable-gpu-vsync');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 960,
    minWidth: 1180,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d0f14',
    title: 'STOOK CREATOR FILMS',
    autoHideMenuBar: true,
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
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(join(RENDERER_DIST, 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerMediaProtocolHandler();
  pipeline = registerFileSystemHandlers(() => mainWindow);
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
