import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Keys of one's own, in the running app: `node tests/ui/keys.mjs`
 *
 *   1. In the keyboard list, "My keys": Split is given F by pressing it.
 *   2. F now splits the clip at the playhead; B, its old key, does nothing;
 *      Ctrl+Z still undoes.
 *   3. Giving Split the key C says it was the razor's; "Reset all" puts the
 *      editor's keys back - B splits again - and the choice survives a reload.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'keys');
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
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
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
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().selectClips([]);
    });
    const clips = () => window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    const at = (frame) => window.evaluate((f) => window.__scfStore.getState().setCurrentFrame(f), frame);
    const openList = async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'shortcuts'));
      await window.getByTestId('shortcuts-dialog').waitFor({ state: 'visible', timeout: 5_000 });
      await window.getByTestId('keys-mode-customize').click();
    };
    // Keys go to the editor itself, not a field: the timeline has the focus.
    const focusEditor = () => window.locator('[data-panel="timeline"] canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);

    console.log('1. choosing a key');
    await openList();
    await window.getByTestId('keys-change-split').click();
    await window.keyboard.press('f');
    const shown = (await window.getByTestId('keys-change-split').innerText()).trim();
    check('Split is given F by pressing it', shown === 'F', shown);
    await window.keyboard.press('Escape');
    await sleep(300);

    console.log('2. using it');
    await focusEditor();
    await at(30);
    await window.keyboard.press('b');
    await sleep(200);
    const afterB = await clips();
    await window.keyboard.press('f');
    await sleep(300);
    const afterF = await clips();
    check('F splits the clip at the playhead; B, its old key, does nothing', afterB === 1 && afterF === 2, `after B ${afterB}, after F ${afterF}`);
    await window.keyboard.press('Control+z');
    await sleep(300);
    check('Ctrl+Z still undoes', (await clips()) === 1, `${await clips()} clip(s)`);

    console.log('3. a key taken, resetting, keeping');
    await openList();
    await window.getByTestId('keys-change-split').click();
    await window.keyboard.press('c');
    const warned = await window.getByTestId('keys-customize').getByText(/Razor tool/).count();
    check('giving Split the key C says it was the razor’s', warned >= 2, `${warned} mentions`);
    await window.getByTestId('keys-reset-all').click();
    const back = (await window.getByTestId('keys-change-split').innerText()).trim();
    await window.keyboard.press('Escape');
    await sleep(300);
    await focusEditor();
    await at(60);
    await window.keyboard.press('b');
    await sleep(300);
    check('Reset all puts the editor’s keys back: B splits again', back === 'B' && (await clips()) === 2, `${back}, ${await clips()} clips`);
    await openList();
    await window.getByTestId('keys-change-marker').click();
    await window.keyboard.press('g');
    await window.keyboard.press('Escape');
    await window.reload();
    await sleep(1500);
    const kept = await window.evaluate(() => window.localStorage.getItem('scf.keys'));
    check('a key chosen is kept after a reload', kept === JSON.stringify({ marker: 'G' }), String(kept));

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
