import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * One caption with a look of its own, in the running app:
 * `node tests/ui/caption-style.mjs`
 *
 * Two captions on one track, white as the track draws them. On the second,
 * "A look of its own" from its Caption tab:
 *   1. it comes up yellow, bold and larger in the export's own picture, and
 *      the first stays white;
 *   2. its size slider and band switch change it, and the track's other
 *      caption keeps the track's look;
 *   3. switched off, or undone, it is the track's again.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'caption-style');
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
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30, durationFrames: 300 });
      window.__scfStore.getState().addTrack('captions');
      const track = window.__scfStore.getState().project.tracks.find((t) => t.type === 'captions');
      const plain = window.__scfStore.getState().addCaptionAt(track.id, 0, 'Hola a todos');
      const loud = window.__scfStore.getState().addCaptionAt(track.id, 150, 'Esto es importante');
      return { plain, loud };
    });
    /** Yellow and white letter pixels in the bottom third of the export's own picture at a frame. */
    const colours = (frame) => window.evaluate(async (at) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, true);
        let yellow = 0;
        let white = 0;
        let top = project.height;
        let bottom = 0;
        for (let y = Math.floor(project.height * 0.6); y < project.height; y += 2) {
          for (let x = 0; x < project.width; x += 2) {
            const i = (y * project.width + x) * 4;
            const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
            if (r > 220 && g > 180 && b < 80) yellow += 1;
            else if (r > 225 && g > 225 && b > 225) white += 1;
            else continue;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
        return { yellow, white, height: bottom - top };
      } finally {
        renderer.endExclusive();
      }
    }, frame);

    console.log('1. a look of its own');
    const before = await colours(165);
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), ids.loud);
    await sleep(300);
    await window.getByTestId('caption-own-style-switch').check();
    await sleep(300);
    const loud = await colours(165);
    const plain = await colours(15);
    check('switched on, the caption is drawn yellow and larger; the other stays white',
      before.yellow === 0 && loud.yellow > 400 && loud.white < 50 && loud.height > before.height && plain.white > 400 && plain.yellow === 0,
      `before ${JSON.stringify(before)}, own ${JSON.stringify(loud)}, other ${JSON.stringify(plain)}`);

    console.log('2. its settings');
    const slider = window.getByTestId('caption-own-style').locator('input[type="range"]');
    await slider.fill('2');
    await sleep(200);
    const bigger = await colours(165);
    await window.getByTestId('caption-own-band-switch').check();
    const style = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.style, ids.loud);
    const otherStyle = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.style ?? null, ids.plain);
    check('the size slider makes it larger still, the band switch puts a band behind it, the other is untouched',
      bigger.height > loud.height && style.scale === 2 && style.band === '#000000' && otherStyle === null, `${loud.height} -> ${bigger.height} px; ${JSON.stringify(style)}`);

    console.log('3. back to the track');
    await window.getByTestId('caption-own-style-switch').uncheck();
    await sleep(300);
    const off = await colours(165);
    const offStyle = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.style ?? null, ids.loud);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.style ?? null, ids.loud);
    check('switched off it is the track look again, and undo brings its own back', off.yellow === 0 && off.white > 400 && offStyle === null && undone?.band === '#000000', `${JSON.stringify(off)}; undo -> ${JSON.stringify(undone)}`);

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
