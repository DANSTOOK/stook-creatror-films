import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The History panel, in the running app: `node tests/ui/history.mjs`
 *
 * Three markers added one after another:
 *   1. the panel lists the start and the three steps, oldest first, the last
 *      one marked as where the project is;
 *   2. a click on the first step goes back to it - one marker - and the two
 *      after it stay below, dimmed; a click on the last of those comes all the
 *      way forward again;
 *   3. a click on "Start" takes everything back; the steps are said in
 *      Spanish when the editor is.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'history');
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
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    for (const frame of [30, 60, 90]) {
      await window.evaluate((f) => {
        window.__scfStore.getState().setCurrentFrame(f);
        window.__scfStore.getState().addMarker();
      }, frame);
      await sleep(600);
    }
    const markers = () => window.evaluate(() => window.__scfStore.getState().project.markers.length);
    const rows = () => window.getByTestId('history-panel').locator('li button').evaluateAll((buttons) => buttons.map((button) => ({ text: button.textContent?.trim(), current: button.getAttribute('aria-current') === 'step', dim: button.className.includes('text-slate-500') })));

    console.log('1. the list');
    await window.getByTestId('history-button').click();
    await window.getByTestId('history-panel').waitFor({ state: 'visible', timeout: 5_000 });
    const listed = await rows();
    check('the start and the three steps, oldest first, the last marked as where it is',
      listed.length === 4 && listed[0].text === 'Start of this session' && listed.slice(1).every((row) => row.text === 'Add marker') && listed[3].current,
      JSON.stringify(listed));

    console.log('2. back and forward');
    await window.getByTestId('history-step-0').click();
    await sleep(300);
    const afterBack = await rows();
    check('a click on the first step goes back to it, the two after it stay below, dimmed', (await markers()) === 1 && afterBack[1].current && afterBack.filter((row) => row.dim).length === 2, `${await markers()} marker(s); ${JSON.stringify(afterBack)}`);
    await window.getByTestId('history-undone-1').click();
    await sleep(300);
    check('a click on the last of them comes all the way forward again', (await markers()) === 3 && (await rows()).at(-1).current, `${await markers()} markers`);

    console.log('3. the start, and in Spanish');
    await window.getByTestId('history-start').click();
    await sleep(300);
    check('a click on the start takes everything back', (await markers()) === 0, `${await markers()} markers`);
    await window.keyboard.press('Escape');
    await window.evaluate(() => window.__scfStore.getState().redo());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(300);
    await window.getByTestId('history-button').click();
    const spanish = await rows();
    check('the steps are said in Spanish when the editor is', spanish[0].text === 'Inicio de esta sesión' && spanish[1].text === 'Añadir marcador', JSON.stringify(spanish.slice(0, 2)));
    await window.keyboard.press('Escape');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('en');
    await window.keyboard.press('Escape');

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
