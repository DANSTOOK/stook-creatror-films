import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Proxies offered as heavy footage arrives: `node tests/ui/proxy-suggest.mjs`
 *
 *   1. importing 1080p offers nothing - it scrubs well;
 *   2. importing two 1440p clips raises one notice for both, with a button
 *      that builds their proxies - theirs, not the 1080p one's - from
 *      wherever it is clicked;
 *   3. Stop in the chip stops the whole queue, not just the file building
 *      then - the second file does not start after the first is killed -
 *      and is not written to the app's log as a failure;
 *   4. the chip's Build builds the rest, and says all are ready;
 *   5. importing the same files again offers nothing more.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'proxy-suggest');
// Its own app log, read back to see that a Stop is not written down as a failure.
const logs = join(work, 'logs');
const logText = () => {
  try {
    const file = readdirSync(logs).find((name) => /^scf-\d{4}-\d{2}-\d{2}\.log$/.test(name));
    return file ? readFileSync(join(logs, file), 'utf8') : '';
  } catch {
    return '';
  }
};
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
  const make = (size, seconds, file) => execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const hd = join(work, 'hd.mp4');
  // The first one long enough to still be building when Stop is pressed.
  const longQhd = join(work, 'long-qhd.mp4');
  const shortQhd = join(work, 'short-qhd.mp4');
  make('1920x1080', 2, hd);
  make('2560x1440', 40, longQhd);
  make('2560x1440', 2, shortQhd);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    const importFiles = async (files) => {
      const before = await window.evaluate(() => window.__scfStore.getState().assets.length);
      await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, files);
      await window.getByRole('button', { name: 'Import', exact: true }).click();
      return before;
    };
    const toastTexts = () => window.evaluate(() => [...document.querySelectorAll('[data-testid="toasts"] .scf-toast')].map((toast) => toast.textContent ?? ''));
    const offers = async () => (await toastTexts()).filter((text) => /heavy/.test(text));
    const proxies = () => window.evaluate(() => Object.fromEntries(window.__scfStore.getState().assets.map((asset) => [asset.name, Boolean(asset.proxyUri)])));
    const spinning = () => window.evaluate(() => Boolean(document.querySelector('[data-testid="proxy-indicator"] .animate-spin')));

    /* 1. 1080p: nothing offered ---------------------------------------------- */
    const before1 = await importFiles([hd]);
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length > count, before1, { timeout: 60_000 });
    await sleep(1500);
    check('1080p footage is not offered a proxy', (await offers()).length === 0, JSON.stringify(await toastTexts()));

    /* 2. two 1440p clips: one notice, with its button ------------------------ */
    const before2 = await importFiles([longQhd, shortQhd]);
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length >= count + 2, before2, { timeout: 60_000 });
    await window.waitForFunction(() => [...document.querySelectorAll('[data-testid="toasts"] .scf-toast')].some((toast) => /heavy/.test(toast.textContent ?? '')), null, { timeout: 10_000 }).catch(() => undefined);
    const offered = await offers();
    check('two heavy clips raise one notice for both', offered.length === 1 && /2 heavy clips/.test(offered[0]), JSON.stringify(offered));
    const button = window.locator('[data-testid="toasts"] button', { hasText: 'Build proxies' });
    check('the notice carries a button that builds them', (await button.count()) === 1);

    // Clicked with another part of the library showing: the chip is not on screen, and need not be.
    await window.getByTestId('library-tab-effects').click();
    await button.click();
    await window.getByTestId('library-tab-media').click();
    await window.waitForFunction(() => Boolean(document.querySelector('[data-testid="proxy-indicator"] .animate-spin')), null, { timeout: 15_000 }).catch(() => undefined);
    check('the button starts building, and the chip shows it', await spinning());

    /* 3. Stop stops the queue ------------------------------------------------ */
    await window.getByTestId('proxy-indicator').click();
    await window.getByRole('button', { name: 'Stop building' }).click();
    await window.waitForFunction(() => !document.querySelector('[data-testid="proxy-indicator"] .animate-spin'), null, { timeout: 20_000 }).catch(() => undefined);
    await sleep(2500);
    const afterStop = await proxies();
    check('Stop stops the whole queue: the second file is not started after the first is killed',
      !(await spinning()) && !afterStop['long-qhd.mp4'] && !afterStop['short-qhd.mp4'], JSON.stringify(afterStop));
    check('the notice built only the clips it named, not the 1080p one', !afterStop['hd.mp4'], JSON.stringify(afterStop));
    const stopLogged = logText().split('\n').filter((line) => /proxy/i.test(line));
    check('a Stop is not written to the log as a failure', stopLogged.length === 0, stopLogged.slice(0, 2).join(' | '));

    /* 4. building again finishes both ---------------------------------------- */
    await window.getByTestId('build-proxies').click();
    await window.keyboard.press('Escape');
    await window.waitForFunction(() => window.__scfStore.getState().assets.every((asset) => asset.proxyUri), null, { timeout: 300_000 }).catch(() => undefined);
    const built = await proxies();
    const chip = (await window.getByTestId('proxy-indicator').textContent())?.trim();
    // The chip builds every heavy file, 1080p too: three, all built.
    check('the chip builds the rest, and says all are ready', built['hd.mp4'] && built['long-qhd.mp4'] && built['short-qhd.mp4'] && chip === '3/3', `${JSON.stringify(built)} chip ${chip}`);

    /* 5. the same files again: nothing more ---------------------------------- */
    await importFiles([longQhd, shortQhd]);
    await sleep(2500);
    check('importing the same files again offers nothing more', (await offers()).length === 0, JSON.stringify(await toastTexts()));

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
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
