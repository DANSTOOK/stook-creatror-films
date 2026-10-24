import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The render queue, in the running app: `node tests/ui/export-queue.mjs`
 *
 *   1. Add to queue keeps the export as set and the timeline as it is: one
 *      queued at 320x180 over two seconds, then - after the timeline
 *      changed and the size too - a second one, the same file name made
 *      "(2)" so it does not overwrite the first;
 *   2. Render queue renders both, one after the other, each as it was
 *      queued: the first two seconds long at 320x180, the second one second
 *      long at 640x360; the list says both are done.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'export-queue');
const out = join(work, 'out');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const probe = (path) => {
  const text = spawnSync(ffmpeg, ['-hide_banner', '-i', path], { encoding: 'utf8' }).stderr;
  const size = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  const duration = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    size: size ? `${size[1]}x${size[2]}` : '?',
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN,
  };
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
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
    const clip = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().updateClip(id, { durationFrames: 60 });
      return id;
    });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, out);

    const openExport = async () => {
      await window.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      return dialog;
    };

    console.log('1. Add to queue');
    let dialog = await openExport();
    await dialog.getByRole('button', { name: 'Whole timeline' }).click();
    await dialog.getByLabel('File name').fill('cut');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await dialog.getByTestId('export-queue-add').click();
    await sleep(300);
    const listed = await dialog.getByTestId('export-queue-job').count();
    check('Add to queue lists the export, waiting', listed === 1 && (await dialog.getByTestId('export-queue-job').first().getAttribute('data-status')) === 'waiting', `${listed} jobs`);
    await dialog.getByTitle('Close').click();
    await sleep(400);

    // The timeline changes, and the size: the first job still renders what it had.
    await window.evaluate((id) => {
      window.__scfStore.getState().updateClip(id, { durationFrames: 30 });
      window.__scfStore.getState().setProjectSettings({ width: 640, height: 360 });
    }, clip);
    dialog = await openExport();
    const kept = await dialog.getByTestId('export-queue-job').count();
    check('the queue is still there when the dialog opens again', kept === 1, `${kept} jobs`);
    await dialog.getByRole('button', { name: 'Whole timeline' }).click();
    await dialog.getByLabel('File name').fill('cut');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await dialog.getByTestId('export-queue-add').click();
    await sleep(300);
    const names = await dialog.getByTestId('export-queue-job').allInnerTexts();
    check('a second one of the same name is made "(2)", not written over the first', names.length === 2 && /cut\.mp4/.test(names[0]) && /cut \(2\)\.mp4/.test(names[1]), names.map((name) => name.replace(/\s+/g, ' ')).join(' | '));
    const button = (await dialog.getByTestId('export-queue-run').innerText()).trim();
    check('the button says how many it will render', button === 'Render queue (2)', button);

    console.log('2. Render queue');
    await window.evaluate(() => {
      window.__queueSeen = new Set();
      new MutationObserver(() => {
        const line = document.querySelector('[data-testid="export-queue-progress"]');
        if (line) window.__queueSeen.add(line.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await dialog.getByTestId('export-queue-run').click();
    const finished = await window.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="export-queue-job"]')];
      return rows.length === 2 && rows.every((row) => row.getAttribute('data-status') === 'done');
    }, null, { timeout: 180_000 }).then(() => true).catch(() => false);
    const seen = await window.evaluate(() => [...window.__queueSeen]);
    if (!finished) console.log('      ' + JSON.stringify(await window.evaluate(() => ({ jobs: window.__scfExportQueue.getState().jobs.map((job) => [job.name, job.status, job.settings.startFrame, job.settings.endFrame, job.settings.width]), alert: document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? null }))));
    check('both render, one after the other, and the list says so', finished, JSON.stringify(seen));
    check('it says which one it is on as it goes', seen.some((line) => /1 of 2 - cut\.mp4/.test(line)) && seen.some((line) => /2 of 2 - cut \(2\)\.mp4/.test(line)), seen.join(' | '));
    const files = readdirSync(out).filter((name) => name.endsWith('.mp4')).sort();
    const first = files.includes('cut.mp4') ? probe(join(out, 'cut.mp4')) : null;
    const second = files.includes('cut (2).mp4') ? probe(join(out, 'cut (2).mp4')) : null;
    check('the first as it was queued: two seconds at 320x180', first?.size === '320x180' && Math.abs(first.seconds - 2) < 0.15, JSON.stringify(first));
    check('the second as it was queued: one second at 640x360', second?.size === '640x360' && Math.abs(second.seconds - 1) < 0.15, JSON.stringify(second));
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
