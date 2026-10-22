import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Stickers, in the running app: `node tests/ui/stickers.mjs`
 *
 *   1. The Stickers tab shows every sticker, each its own picture.
 *   2. A click puts one over the picture at the playhead, on a track of its
 *      own, a third of the frame tall, popping on and with its loop - and it
 *      is in the export's own picture, in its colour.
 *   3. The same sticker again reuses its file; the lettered ones are drawn in
 *      the interface's language; one undo takes the clip off.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'stickers');
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
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));

    console.log('1. the tab');
    await window.getByTestId('library-tab-stickers').click();
    await window.getByTestId('library-stickers').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(300);
    const tiles = await window.evaluate(() => {
      const canvases = [...document.querySelectorAll('[data-testid^="library-sticker-"] canvas')];
      const hashes = canvases.map((canvas) => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 0;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4 * 7) {
          hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3]) % 1000003;
          if (data[i + 3] > 0) lit += 1;
        }
        return { hash, lit };
      });
      return { count: canvases.length, distinct: new Set(hashes.map((h) => h.hash)).size, empty: hashes.filter((h) => h.lit === 0).length };
    });
    check('every sticker is shown, each its own picture', tiles.count === 18 && tiles.distinct === 18 && tiles.empty === 0, JSON.stringify(tiles));

    console.log('2. one onto the picture');
    await window.getByTestId('library-sticker-heart').click();
    const added = await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 30_000 }).then(() => true).catch(() => false);
    const heart = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips)[0];
      const asset = s.assets.find((a) => a.uri === clip.sourceUri);
      const scale = clip.transform.scale.at(-1)?.value;
      return { name: clip.name, path: asset?.sourcePath ?? '', kind: asset?.kind, scaleY: scale?.y, fx: clip.fx, start: clip.startFrame, tracks: s.project.tracks.filter((t) => t.type === 'video').length, selected: s.ui.selectedClipIds.includes(clip.id) };
    });
    check('a click puts it on a track of its own, a third of the frame tall, popping on and with its loop',
      added && heart.name === 'Heart' && heart.kind === 'image' && /stickers[\\/]heart\.png$/.test(heart.path) && Math.abs(heart.scaleY - 0.34) < 0.02 && heart.fx?.in?.id === 'popIn' && heart.fx?.loop?.id === 'pulse' && heart.tracks === 3 && heart.selected,
      JSON.stringify(heart));
    const reds = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, 45, true);
        let red = 0;
        let white = 0;
        for (let y = 0; y < project.height; y += 3) {
          for (let x = 0; x < project.width; x += 3) {
            const i = (y * project.width + x) * 4;
            if (rgba[i] > 190 && rgba[i + 1] < 120 && rgba[i + 2] < 150) red += 1;
            else if (rgba[i] > 235 && rgba[i + 1] > 235 && rgba[i + 2] > 235) white += 1;
          }
        }
        return { red, white };
      } finally {
        renderer.endExclusive();
      }
    });
    check('it is in the export’s own picture: a red heart with its white outline', reds.red > 2000 && reds.white > 200, JSON.stringify(reds));

    console.log('3. again, words, undo');
    await window.getByTestId('library-sticker-heart').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 30_000 });
    const assetsAfterTwo = await window.evaluate(() => window.__scfStore.getState().assets.length);
    await window.getByTestId('library-sticker-subscribe').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 3, null, { timeout: 30_000 });
    const subscribe = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      return s.assets.map((a) => a.sourcePath ?? '').find((path) => /subscribe/.test(path)) ?? '';
    });
    check('the same sticker again reuses its file; a lettered one is kept per language', assetsAfterTwo === 1 && /subscribe-en\.png$/.test(subscribe), `${assetsAfterTwo} asset(s); ${subscribe}`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('one undo takes the last sticker off', left === 2, `${left} clips left`);

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
