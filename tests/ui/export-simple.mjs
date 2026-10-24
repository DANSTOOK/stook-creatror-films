import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The export, simple the way CapCut's is: `node tests/ui/export-simple.mjs`
 *
 *   1. it opens on a large picture of what will be made - the frame at the
 *      playhead, drawn as the render will draw it - beside the name, the
 *      place, the format, the size and the range; the rest is under More
 *      settings, folded;
 *   2. More settings opens the presets, the networks and the GIF, and stays
 *      open the next time the dialog opens;
 *   3. while it renders, the picture is the render itself, frame after frame,
 *      with how far it has got over it;
 *   4. done, a tick over the picture, and the file's card with Show in folder.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'export-simple');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'out'), { recursive: true });
  // A clip whose picture changes all along: the render's frames tell apart.
  const video = join(work, 'moving.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
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
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video' && t.order === 0).id, 0);
      window.__scfStore.getState().setCurrentFrame(90);
    });
    await sleep(800);

    /** The preview's picture: how bright it is on average, and a fingerprint of a row of it. */
    const picture = () => window.evaluate(() => {
      const canvas = document.querySelector('[data-testid="export-preview"]');
      if (!canvas || !canvas.width) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4 * 29) sum += data[i] + data[i + 1] + data[i + 2];
      const row = Math.floor(canvas.height * 0.8) * canvas.width * 4;
      let print = '';
      for (let x = 0; x < canvas.width; x += Math.floor(canvas.width / 16)) print += (data[row + x * 4] >> 5).toString(16);
      return { mean: Math.round(sum / (data.length / (4 * 29)) / 3), print, state: canvas.dataset.state };
    });
    const openExport = async () => {
      await window.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: /Start export|New export/ }).first().waitFor({ state: 'visible', timeout: 10_000 });
      return dialog;
    };

    /* 1. the picture and the essentials ------------------------------------------------ */
    let dialog = await openExport();
    await window.waitForSelector('[data-testid="export-preview"][data-state="ready"]', { timeout: 20_000 }).catch(() => undefined);
    const opening = await picture();
    check('it opens on a large picture of the frame at the playhead', opening?.state === 'ready' && opening.mean > 40 && (await dialog.getByTestId('export-preview').boundingBox()).width >= 360, JSON.stringify(opening));
    const essentials = await Promise.all(['File name', 'Start frame', 'End frame'].map((label) => dialog.getByLabel(label).isVisible()));
    const essentialsByText = await Promise.all(['Format', 'Resolution'].map((label) => dialog.getByText(label, { exact: true }).first().isVisible()));
    const more = dialog.getByTestId('export-more');
    const folded = (await more.getAttribute('aria-expanded')) === 'false' && !(await dialog.getByRole('button', { name: /^Sprite frames/ }).isVisible().catch(() => false));
    check('beside it the name, the place, the format, the size and the range; the rest folded under More settings', essentials.every(Boolean) && essentialsByText.every(Boolean) && folded, JSON.stringify({ essentials, essentialsByText, folded }));

    /* 2. More settings ------------------------------------------------------------------ */
    await more.click();
    const opened = await Promise.all([
      dialog.getByRole('button', { name: /^Sprite frames/ }).isVisible(),
      dialog.getByTestId('export-networks').isVisible(),
      dialog.getByTestId('export-gif').isVisible(),
    ]);
    check('More settings opens the presets, the networks and the GIF', opened.every(Boolean), JSON.stringify(opened));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await sleep(500);
    dialog = await openExport();
    check('and is still open the next time', (await dialog.getByTestId('export-more').getAttribute('aria-expanded')) === 'true');
    await dialog.getByTestId('export-more').click();

    /* 3. the render, as it is made ------------------------------------------------------- */
    await app.evaluate(({ dialog: native }, folder) => { native.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(work, 'out'));
    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill('600');
    await dialog.getByLabel('File name').fill('moving-out');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await dialog.getByRole('button', { name: 'Start export' }).click();
    const prints = new Set();
    let percentShown = false;
    for (let sample = 0; sample < 40; sample += 1) {
      await sleep(150);
      const now = await picture();
      if (now) prints.add(now.print);
      if (await window.getByTestId('export-preview-percent').isVisible().catch(() => false)) percentShown = true;
      if (await window.getByTestId('export-preview-done').isVisible().catch(() => false)) break;
    }
    check('while it renders, the picture is the render itself, frame after frame, with how far it has got', percentShown && prints.size >= 3, `${prints.size} different pictures; percent ${percentShown}`);

    /* 4. done ---------------------------------------------------------------------------------- */
    await window.getByTestId('export-preview-done').waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined);
    const doneShown = await window.getByTestId('export-preview-done').isVisible().catch(() => false);
    const card = await dialog.getByTestId('export-result').isVisible().catch(() => false);
    const folderButton = await dialog.getByRole('button', { name: 'Show in folder' }).isVisible().catch(() => false);
    const file = join(work, 'out', 'moving-out.mp4');
    check('done: a tick over the picture, the file\'s card with Show in folder, and the file where it was asked', doneShown && card && folderButton && existsSync(file) && statSync(file).size > 10_000, `${doneShown} ${card} ${folderButton} ${existsSync(file) ? statSync(file).size : 'no file'}`);

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
