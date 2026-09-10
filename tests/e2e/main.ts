import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerFileSystemHandlers, allowPath } from '../../src/main/ipc/fileSystem';

/**
 * Electron host for the end-to-end run.
 *
 * Uses the application's real IPC handlers and real EncoderPipeline - the only
 * thing that differs from a normal launch is the page it loads and the fact
 * that it quits when the scenario reports back.
 */

const inputs = {
  videoPath: process.env.E2E_VIDEO ?? '',
  spritePath: process.env.E2E_SPRITE ?? '',
  mp4Output: process.env.E2E_MP4 ?? '',
  pngOutput: process.env.E2E_PNG ?? '',
  useRealExportPath: process.env.E2E_REAL_EXPORT === '1',
  colourFramePath: process.env.E2E_COLOUR_DIR ?? '',
  colourFrame: Number(process.env.E2E_COLOUR_FRAME ?? 0),
  ...(process.env.E2E_START ? { startFrame: Number(process.env.E2E_START) } : {}),
  ...(process.env.E2E_END ? { endFrame: Number(process.env.E2E_END) } : {}),
};

// The renderer may only touch files that came from a dialog; in this harness
// the harness itself vouches for them.
for (const path of Object.values(inputs)) {
  if (typeof path === 'string' && path) allowPath(path);
}

// Software rendering keeps the test reproducible on machines with no usable
// GPU, but it also changes which codecs WebCodecs offers - so an audit of the
// real export path runs on the real GPU instead.
if (process.env.E2E_USE_GPU !== '1') {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

let window: BrowserWindow | null = null;
let finished = false;

function finish(payload: unknown, code: number): void {
  if (finished) return;
  finished = true;
  // The runner parses this line out of stdout.
  process.stdout.write(`\n__E2E_RESULT__${JSON.stringify(payload)}__E2E_END__\n`);
  setTimeout(() => app.exit(code), 100);
}

app.whenReady().then(() => {
  registerFileSystemHandlers(() => window);

  window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
      // A hidden window would otherwise have its timers throttled.
      backgroundThrottling: false,
    },
  });

  window.webContents.on('console-message', (_event, _level, message) => {
    process.stdout.write(`[renderer] ${message}\n`);
  });

  window.webContents.on('render-process-gone', (_event, details) =>
    finish({ ok: false, error: `renderer gone: ${details.reason}` }, 1),
  );

  window.webContents.once('did-finish-load', async () => {
    try {
      // executeJavaScript resolves with the awaited value of the expression,
      // so the scenario's result comes straight back here.
      const result = await window!.webContents.executeJavaScript(
        `window.__runE2E(${JSON.stringify(inputs)})`,
      );
      finish(result, (result as { ok: boolean }).ok ? 0 : 1);
    } catch (error) {
      finish(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        1,
      );
    }
  });

  void window.loadFile(join(__dirname, '../renderer/index.html'));
});

// A hung decode must not leave the harness running forever.
setTimeout(() => finish({ ok: false, error: 'timed out after 180s' }, 1), 180_000);
