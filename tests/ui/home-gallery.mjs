import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The start screen, the way CapCut's home is laid out: `node tests/ui/home-gallery.mjs`
 *
 *   1. a big Create project card heads the right side, the one Create button
 *      on the screen, with Blank project and Open beside it;
 *   2. it says what it will make, and says it again when the shape, the
 *      quality or the name change;
 *   3. it makes exactly that: 9:16 at 1080p is a 1080×1920 project, named as
 *      typed;
 *   4. importing a landscape clip into it keeps it 9:16 - the frame was
 *      chosen, not left for the first clip to set;
 *   5. a saved project's card says how long its edit is - the end of its
 *      last clip, not the minute a new project's canvas starts at.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'home-gallery');
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
  const video = join(work, 'twelve.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);
  const folder = join(work, 'projects');
  mkdirSync(folder, { recursive: true });

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
    const create = window.getByRole('button', { name: 'Create project' });
    await create.waitFor({ state: 'visible', timeout: 30_000 });

    /* 1. the card and its neighbours --------------------------------------------- */
    const layout = await window.evaluate(() => {
      const box = (element) => element?.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('button')];
      const card = box(document.querySelector('[data-testid="home-create"]'));
      const blank = box(buttons.find((button) => button.textContent?.trim() === 'Blank project'));
      const open = box(buttons.find((button) => /^Open project/.test(button.textContent?.trim() ?? '')));
      const recent = box([...document.querySelectorAll('h2')].find((heading) => /Recent/.test(heading.textContent ?? '')));
      return {
        creates: buttons.filter((button) => /Create project/.test(button.textContent ?? '')).length,
        big: card ? card.width >= 400 && card.height >= 120 : false,
        beside: Boolean(card && blank && open && Math.abs(blank.top - card.top) < 2 && Math.abs(open.top - card.top) < 2 && blank.left > card.right && open.left > blank.right),
        above: Boolean(card && recent && card.bottom <= recent.top),
      };
    });
    check('a big Create project card heads the right side, the one Create button, Blank and Open beside it', layout.creates === 1 && layout.big && layout.beside && layout.above, JSON.stringify(layout));

    /* 2. it says what it will make ------------------------------------------------- */
    const summary = () => window.getByTestId('home-create-summary').innerText();
    const first = await summary();
    await window.getByTestId('home-shape-vertical').click();
    const nameField = window.getByRole('textbox').first();
    await nameField.fill('Mi short');
    await sleep(200);
    const second = await summary();
    check('it says what it will make, and follows the choices', /^16:9 · 1920×1080 · 30 fps · /.test(first) && second === '9:16 · 1080×1920 · 30 fps · Mi short', `${first} | ${second}`);

    /* 3. it makes exactly that ------------------------------------------------------- */
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, folder);
    await window.getByRole('button', { name: 'Change' }).click().catch(() => undefined);
    await sleep(300);
    await create.click();
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await sleep(500);
    const made = await window.evaluate(() => ({ width: window.__scfStore.getState().project.width, height: window.__scfStore.getState().project.height, fps: window.__scfStore.getState().project.fps }));
    const titled = await window.getByTestId('project-name').innerText().catch(() => '');
    check('it makes exactly that: a 1080×1920 project at 30 fps, named as typed', made.width === 1080 && made.height === 1920 && made.fps === 30 && /Mi short/.test(titled), `${JSON.stringify(made)} "${titled}"`);

    /* 4. the card says how long the edit is ------------------------------------------ */
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video' && t.order === 0).id, 0);
    });
    await sleep(300);
    const kept = await window.evaluate(() => ({ width: window.__scfStore.getState().project.width, height: window.__scfStore.getState().project.height }));
    check('a landscape clip imported into it leaves it 9:16: the frame was chosen', kept.width === 1080 && kept.height === 1920, JSON.stringify(kept));
    await window.keyboard.press('Control+s');
    await sleep(1500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'home'));
    await create.waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(800);
    const card = await window.evaluate(() => [...document.querySelectorAll('li')].map((item) => item.innerText).find((text) => /Mi short/.test(text)) ?? '');
    check('the saved project\'s card says its edit runs 0:12, not a minute, at 1080×1920', /0:12/.test(card) && !/1:00/.test(card) && /1080×1920/.test(card), card.replace(/\s+/g, ' '));

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
