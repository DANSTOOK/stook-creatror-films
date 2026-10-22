import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Exporting for social networks, in the running app:
 * `node tests/ui/export-networks.mjs`
 *
 * A landscape project, TikTok and YouTube ticked in the export dialog:
 *   1. each says how the project shows there - TikTok with bars above and
 *      below, YouTube filling the screen - and a note says why;
 *   2. one click renders a file for each, one after the other, named after
 *      the network, at the project's own shape and the network's size,
 *      saying which version it is on as it goes;
 *   3. a vertical project fills TikTok.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'export-networks');
const out = join(work, 'out');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Width x height of a file's first video stream, from ffmpeg's own reading of it. */
function sizeOf(file) {
  const text = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr ?? '';
  const match = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(text);
  return match ? `${match[1]}x${match[2]}` : null;
}

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setExportSettings({ startFrame: 0, endFrame: 30 });
    });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, out);

    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill('30');
    await dialog.getByLabel('File name').fill('trip');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);

    console.log('1. how it shows on each');
    await dialog.getByTestId('export-network-tiktok').click();
    await dialog.getByTestId('export-network-youtube').click();
    const tiktok = (await dialog.getByTestId('export-network-tiktok').innerText()).replace(/\s+/g, ' ');
    const youtube = (await dialog.getByTestId('export-network-youtube').innerText()).replace(/\s+/g, ' ');
    const note = await dialog.getByText(/keeps your project.s shape/).count();
    const button = (await dialog.getByTestId('export-networks-start').innerText()).trim();
    check('TikTok says bars above and below, YouTube fills the screen, and a note says why', /File 1920x1080 ?Bars above and below on its 9:16 screen/.test(tiktok) && /File 1920x1080 ?Fills its 16:9 screen/.test(youtube) && note === 1 && button === 'Export for 2 networks', `${tiktok} | ${youtube} | "${button}"`);

    console.log('2. one click, a file each');
    await window.evaluate(() => {
      window.__versionsSeen = new Set();
      new MutationObserver(() => {
        const line = document.querySelector('[data-testid="export-networks-progress"]');
        if (line) window.__versionsSeen.add(line.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await dialog.getByTestId('export-networks-start').click();
    const finished = await window.getByText('2 versions exported', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 }).then(() => true).catch(() => false);
    const versions = await window.evaluate(() => [...window.__versionsSeen]);
    const files = readdirSync(out).filter((name) => name.endsWith('.mp4')).sort();
    const sizes = files.map((name) => `${name} ${sizeOf(join(out, name))}`);
    check('one click renders a file for each, named after the network, at the project shape and the network size',
      finished && files.join('|') === 'trip - TikTok.mp4|trip - YouTube.mp4' && sizes.every((line) => line.endsWith('1920x1080')), sizes.join(' | '));
    check('it says which version it is on as it goes', versions.includes('Version 1 of 2: YouTube') && versions.includes('Version 2 of 2: TikTok'), versions.join(' | '));
    await dialog.getByTitle('Close').click().catch(() => undefined);
    await sleep(400);

    console.log('3. a vertical project');
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1080, height: 1920, fps: 30 }));
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    await dialog.getByRole('button', { name: /Start export|New export/ }).first().waitFor({ state: 'visible', timeout: 10_000 });
    const newExport = dialog.getByRole('button', { name: 'New export' });
    if (await newExport.count()) await newExport.click();
    const vertical = (await dialog.getByTestId('export-network-tiktok').innerText()).replace(/\s+/g, ' ');
    check('a vertical project fills TikTok at 1080x1920', /File 1080x1920 ?Fills its 9:16 screen/.test(vertical), vertical);

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
