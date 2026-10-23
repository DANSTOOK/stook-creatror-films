import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The welcome tour, in the running app: `node tests/ui/tour.mjs`
 *
 *   1. The first time the editor opens, the tour does: six stops, each lighting
 *      up what it is about - the library, the viewer, the timeline, the
 *      inspector, the workspaces, Export - the card beside it, in the window;
 *   2. Next goes through them, Back goes back, and the last one closes it;
 *   3. after a restart it does not come back on its own;
 *   4. Help › Welcome tour shows it again, and Escape puts it away.
 *
 * SCF_TOUR=1 lets it show in an automated run, which it otherwise never does.
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tour');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function launch(profile) {
  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_TOUR: '1' },
  });
  const window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
  await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  return { app, window, pid: app.process().pid };
}

async function close({ app, pid }) {
  await app.close().catch(() => undefined);
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Already gone.
  }
}

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);
  const issues = [];

  let session = await launch(profile);
  try {
    const { window } = session;
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));

    console.log('1. the first time');
    const shown = await window.getByTestId('welcome-tour').waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    const targets = ['[data-panel="media"]', '[data-testid="preview-panel"]', '[data-panel="timeline"]', '[data-panel="inspector"]', '[data-testid="workspace-picker"]', '[data-testid="titlebar-export"]'];
    const stops = [];
    for (let index = 0; index < targets.length; index += 1) {
      await sleep(450);
      stops.push(await window.evaluate((selector) => {
        const lit = document.querySelector('[data-testid="welcome-tour-spotlight"]')?.getBoundingClientRect();
        const target = document.querySelector(selector)?.getBoundingClientRect();
        const card = document.querySelector('[data-testid="welcome-tour"] .scf-rise')?.getBoundingClientRect();
        const around = lit && target && Math.abs(lit.left - (target.left - 6)) < 3 && Math.abs(lit.width - (target.width + 12)) < 3 && Math.abs(lit.top - (target.top - 6)) < 3;
        const inWindow = card && card.left >= 0 && card.top >= 0 && card.right <= window.innerWidth && card.bottom <= window.innerHeight;
        return { title: document.querySelector('[data-testid="welcome-tour-title"]')?.textContent, count: document.querySelector('[data-testid="welcome-tour-count"]')?.textContent, around: Boolean(around), inWindow: Boolean(inWindow) };
      }, targets[index]));
      if (index === 1) {
        await window.getByTestId('welcome-tour-back').click();
        await sleep(300);
        stops.push({ back: await window.getByTestId('welcome-tour-title').textContent() });
        await window.getByTestId('welcome-tour-next').click();
        await sleep(300);
      }
      if (index < targets.length - 1) await window.getByTestId('welcome-tour-next').click();
    }
    const lit = stops.filter((stop) => 'around' in stop);
    check('the first time the editor opens, the tour does', shown);
    check('six stops, each lighting up what it is about, the card in the window',
      lit.length === 6 && lit.every((stop) => stop.around && stop.inWindow) && lit[0].count === '1 of 6' && lit[5].title === 'Export',
      JSON.stringify(lit.map((stop) => `${stop.title}${stop.around ? '' : ' (not lit)'}${stop.inWindow ? '' : ' (outside)'}`)));
    check('Back goes back a stop', stops[2]?.back === 'Your library', JSON.stringify(stops[2]));
    await window.getByTestId('welcome-tour-next').click();
    await sleep(300);
    const closed = await window.getByTestId('welcome-tour').isVisible().catch(() => false);
    check('the last one closes it', !closed);
  } finally {
    await close(session);
  }

  console.log('2. after a restart');
  session = await launch(profile);
  try {
    const { app, window } = session;
    await sleep(1500);
    const again = await window.getByTestId('welcome-tour').isVisible().catch(() => false);
    check('after a restart it does not come back on its own', !again);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'tour'));
    const reopened = await window.getByTestId('welcome-tour').waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false);
    await window.keyboard.press('Escape');
    await sleep(300);
    const away = !(await window.getByTestId('welcome-tour').isVisible().catch(() => false));
    check('Help › Welcome tour shows it again, and Escape puts it away', reopened && away);
  } finally {
    await close(session);
  }

  check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
