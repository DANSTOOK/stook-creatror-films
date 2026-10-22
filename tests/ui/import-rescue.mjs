import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Starting a project and getting footage in, in the running app:
 * `node tests/ui/import-rescue.mjs`
 *
 *   1. The start screen picks a project's format by its shape - vertical for
 *      TikTok is a click - and its quality, and creates it at that size.
 *   2. A video the decoder turns away but every player opens (a phone or
 *      stock MP4 timed before zero) comes in all the same, through a repacked
 *      copy, and plays and renders; the original stays the asset's file.
 *   3. A video in a codec the decoder has not got (MPEG-4 Part 2) comes in
 *      converted to H.264, and says so.
 *
 * Step 2 uses ~/Downloads/368458.mp4 when it is there (read only) and is
 * skipped otherwise. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'import-rescue');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stock = join(process.env.USERPROFILE ?? '', 'Downloads', '368458.mp4');

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'projects'), { recursive: true });
  const oldCodec = join(work, 'old-codec.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-shortest', oldCodec]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && !/AudioContext/.test(message.text()) && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));

    console.log('1. a vertical project from the start screen');
    await window.getByTestId('home-shape-vertical').click({ timeout: 30_000 });
    const quality = window.getByTestId('home-quality');
    const vertical = await quality.locator('option:checked').innerText();
    const where = await window.getByTestId('home-shape-where').innerText();
    await window.getByTestId('home-shape-portrait').click();
    const portrait = await quality.locator('option:checked').innerText();
    await window.getByTestId('home-shape-vertical').click();
    check('Vertical is 1080x1920 for TikTok, Reels and Shorts; Portrait 4:5 is 1080x1350',
      /1080x1920$/.test(vertical) && /TikTok/.test(where) && /1080x1350$/.test(portrait) && (await window.getByTestId('home-shape-vertical').getAttribute('aria-checked')) === 'true',
      `${vertical} | ${where} | ${portrait}`);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(work, 'projects'));
    await window.getByRole('button', { name: 'Change' }).click();
    await sleep(300);
    await window.getByRole('button', { name: 'Create project' }).click();
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const size = await window.evaluate(() => { const p = window.__scfStore.getState().project; return `${p.width}x${p.height}`; });
    check('Create project makes it at that size', size === '1080x1920', size);

    const importOne = async (path) => {
      const before = await window.evaluate(() => window.__scfStore.getState().assets.length);
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [path]);
      await window.getByRole('button', { name: 'Import', exact: true }).click();
      const started = Date.now();
      const ok = await window.waitForFunction((n) => window.__scfStore.getState().assets.length > n, before, { timeout: 180_000 }).then(() => true).catch(() => false);
      const asset = await window.evaluate(() => window.__scfStore.getState().assets.at(-1));
      // The viewer takes the new file in on its next update.
      await sleep(800);
      return { ok, asset, seconds: (Date.now() - started) / 1000 };
    };
    const renders = (asset) =>
      window.evaluate(async (uri) => {
        const s = window.__scfStore.getState();
        const track = s.project.tracks.find((t) => t.type === 'video');
        for (const id of Object.keys(s.project.clips)) window.__scfStore.getState().removeClips?.([id]);
        const added = window.__scfStore.getState().addAssetToTimeline(window.__scfStore.getState().assets.find((a) => a.uri === uri), track.id, 0);
        const project = window.__scfStore.getState().project;
        const only = { ...project, clips: { [added]: project.clips[added] } };
        const renderer = window.__scfRenderer();
        renderer.beginExclusive();
        try {
          const rgba = await renderer.renderExact(only, 15, true);
          let lit = 0;
          for (let i = 0; i < rgba.length; i += 4 * 97) if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 60) lit += 1;
          return lit;
        } finally {
          renderer.endExclusive();
        }
      }, asset.uri);
    const toasts = () => window.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"]')].map((node) => node.textContent ?? '').join(' | '));

    console.log('2. a video timed before zero');
    if (existsSync(stock)) {
      const { ok, asset, seconds } = await importOne(stock);
      const lit = ok ? await renders(asset) : 0;
      const said = await toasts();
      check('it comes in through a repacked copy in seconds, and its picture renders', ok && asset.playable === 'remux' && asset.sourcePath === stock && seconds < 30 && lit > 500,
        `${seconds.toFixed(1)} s, playable ${asset?.playable}, ${lit} lit samples`);
      check('it says the file was repacked and the picture is unchanged', /repacked/.test(said), said.slice(0, 160));
    } else {
      console.log('   SKIP  no ~/Downloads/368458.mp4');
    }

    console.log('3. a codec the decoder has not got');
    const { ok, asset, seconds } = await importOne(oldCodec);
    const lit = ok ? await renders(asset) : 0;
    const said = await toasts();
    check('it comes in converted to H.264, and its picture renders', ok && asset.playable === 'transcode' && asset.sourcePath === oldCodec && lit > 500 && Math.abs(asset.durationSeconds - 3) < 0.2,
      `${seconds.toFixed(1)} s, playable ${asset?.playable}, ${asset?.durationSeconds?.toFixed(2)} s long, ${lit} lit samples`);
    check('it says it was converted and the file is untouched', /converted to H\.264/.test(said), said.slice(0, 160));

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
