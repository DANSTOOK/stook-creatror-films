import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Starter kits, in the running app: `node tests/ui/kits.mjs`
 *
 *   1. The start screen offers Blank and the four kits, and says what each is.
 *   2. The vertical Short kit builds its pieces into a 1080x1920 project: a
 *      background at the BOTTOM, the safe-area frame ABOVE the footage, and two
 *      titles - with the background drawn at the project's own size, which is
 *      the whole reason a kit is code and not a saved file.
 *   3. It is ONE undo step: one Ctrl+Z and the timeline is empty.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'kits');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** What the kit left on the timeline, bottom row first. */
const built = (window) =>
  window.evaluate(() => {
    const { project, assets } = window.__scfStore.getState();
    const byUri = new Map(assets.map((asset) => [asset.uri, asset]));
    const rows = project.tracks.filter((track) => track.type !== 'audio').sort((a, b) => a.order - b.order);
    const at = (clip) => rows.findIndex((row) => row.id === clip.trackId);
    const clips = Object.values(project.clips).map((clip) => {
      const asset = byUri.get(clip.sourceUri);
      return {
        row: at(clip),
        title: Boolean(clip.title),
        file: (asset?.sourcePath ?? '').split(/[\\/]/).pop() ?? '',
        width: asset?.width ?? 0,
        height: asset?.height ?? 0,
        seconds: Number((clip.durationFrames / project.fps).toFixed(2)),
        loop: clip.fx?.loop?.id ?? null,
      };
    });
    return { size: `${project.width}x${project.height}`, clips: clips.sort((a, b) => a.row - b.row) };
  });

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_PROJECTS_DIR: join(work, 'projects'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="home-kit-blank"]', { timeout: 30_000 });

    console.log('1. what the start screen offers');
    const offered = await Promise.all(
      ['blank', 'short', 'podcast', 'tutorial', 'cover'].map((id) => window.getByTestId(`home-kit-${id}`).isVisible().catch(() => false)),
    );
    check('Blank and the four kits are all there', offered.every(Boolean), offered.join());
    await window.getByTestId('home-kit-short').click();
    await sleep(200);
    const says = await window.getByTestId('home-kit-what').textContent();
    check('choosing one says what it builds', (says ?? '').length > 20, `${(says ?? '').slice(0, 54)}…`);

    console.log('2. the Short kit in a vertical project');
    await window.getByTestId('home-shape-vertical').click();
    await sleep(150);
    await window.getByTestId('home-create').click();
    const made = await window
      .waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length >= 4, null, { timeout: 120_000 })
      .then(() => true)
      .catch(() => false);
    check('it builds its pieces into the new project', made);
    if (!made) throw new Error('the kit never arrived');
    await sleep(400);
    const short = await built(window);
    const background = short.clips.find((clip) => /^bg-/.test(clip.file));
    const frame = short.clips.find((clip) => /^frame-/.test(clip.file));
    const titles = short.clips.filter((clip) => clip.title);
    check('the project is the vertical one that was chosen', short.size === '1080x1920', short.size);
    check(
      'a background at the bottom, drawn at the project’s own size',
      Boolean(background) && background.row === 0 && background.width === 1080 && background.height === 1920,
      background ? `row ${background.row}, ${background.width}x${background.height}, ${background.file}` : 'no background',
    );
    check(
      'the safe-area frame above the footage',
      Boolean(frame) && Boolean(background) && frame.row > background.row && /safeshorts/i.test(frame.file),
      frame ? `row ${frame.row}, ${frame.file}` : 'no frame',
    );
    check('two titles', titles.length === 2, `${titles.length} titles`);
    check('the background moves', background?.loop !== null && background?.loop !== undefined, String(background?.loop));
    check(
      'and the piece is as long as the kit says',
      Boolean(background) && Math.abs(background.seconds - 15) < 0.1,
      `${background?.seconds}s`,
    );

    console.log('3. one undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(400);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('one undo leaves the timeline empty', left === 0, `${left} clips left`);


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
