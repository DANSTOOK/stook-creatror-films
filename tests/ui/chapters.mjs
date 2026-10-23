import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * YouTube chapters from markers, in the running app: `node tests/ui/chapters.mjs`
 *
 * A two-minute edit with markers at 0:30 "The build" and 1:15 "Results", one
 * at 0:35 too close to the one before, and a beat marker:
 *   1. the ruler's menu offers "Copy YouTube chapters";
 *   2. the clipboard then holds 00:00 Intro / 00:30 The build / 01:15 Results,
 *      the user is told three were copied and one left out;
 *   3. with no markers the entry is greyed out.
 *
 * The clipboard is the system's: what was on it is put back afterwards.
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'chapters');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'two-minutes.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x334155:s=320x180:r=30:d=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  const kept = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      window.__scfStore.getState().zoomToFit();
    });
    await sleep(500);
    const rulerMenu = async () => {
      const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
      // An empty stretch of the ruler, away from the flags.
      const x = await window.evaluate(() => 100 * 30 * window.__scfStore.getState().ui.pixelsPerFrame - window.__scfStore.getState().ui.scrollLeftPx);
      await window.mouse.click(canvas.x + x, canvas.y + 6, { button: 'right' });
      return window.getByRole('menuitem', { name: /Copy YouTube chapters/ });
    };

    console.log('1. no markers');
    const none = await rulerMenu();
    const greyed = await none.isDisabled().catch(() => false);
    await window.keyboard.press('Escape');
    check('with no markers, "Copy YouTube chapters" is greyed out', greyed);

    console.log('2. copying');
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const add = (seconds, label) => {
        const id = s.addMarker(seconds * 30);
        window.__scfStore.getState().updateMarker(id, { label });
      };
      add(30, 'The build');
      add(35, 'Too soon');
      add(75, 'Results');
      add(90, '♪');
    });
    const item = await rulerMenu();
    const offered = await item.isVisible().catch(() => false);
    check('the ruler’s menu offers "Copy YouTube chapters"', offered);
    if (offered) await item.click();
    await sleep(500);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    check('the clipboard holds the chapters as YouTube reads them', copied === '00:00 Intro\n00:30 The build\n01:15 Results', JSON.stringify(copied));
    const told = await window.evaluate(() => document.body.innerText);
    check('the user is told three were copied, and one left out', /3 YouTube chapters copied/.test(told) && /less than 10 seconds after the chapter before[^:]*: 1\./.test(told), (told.match(/\d+ YouTube chapters copied[^\n]*/g) ?? []).join(' | '));

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), kept).catch(() => undefined);
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
