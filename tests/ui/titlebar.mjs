import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The title bar and the library's rail, CapCut's way: `node tests/ui/titlebar.mjs`
 *
 *   1. Undo and Redo are on the bar, greyed until there is something to take
 *      back, and each takes one step;
 *   2. the More menu holds the rest: finding a command opens the palette, the
 *      mixer opens beside the timeline, Preferences opens; the timeline's own
 *      Mixer button opens and closes it too;
 *   3. the library's parts are a rail down its side, every name shown, the
 *      arrow keys moving between them;
 *   4. the project's name in the middle is renamed with a click: not saved
 *      yet, it is just the name; saved, the file on disk is renamed with it
 *      and the start screen lists it under its new name; a name another
 *      project in the folder has is refused.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'titlebar');
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

    console.log('1. Undo and Redo');
    const undoOff = await window.getByTestId('titlebar-undo').isDisabled();
    await window.evaluate(() => window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 0 }));
    await sleep(200);
    const count = () => window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    const made = await count();
    await window.getByTestId('titlebar-undo').click();
    await sleep(200);
    const undone = await count();
    await window.getByTestId('titlebar-redo').click();
    await sleep(200);
    const redone = await count();
    check('Undo waits for something to take back, then each takes a step, and Redo puts it back', undoOff && made === 1 && undone === 0 && redone === 1, JSON.stringify({ undoOff, made, undone, redone }));

    console.log('2. the More menu, and the mixer by the timeline');
    await window.getByTestId('titlebar-more').click();
    const items = await window.locator('[role^="menuitem"]').allInnerTexts();
    check('More holds finding a command, the mixer, Preferences, the shortcuts and the tour', ['Search', 'Mixer', 'Settings', 'Keyboard shortcuts', 'Welcome tour'].every((name) => items.some((item) => item.startsWith(name))), items.map((item) => item.split('\n')[0]).join(' | '));
    await window.getByRole('menuitem', { name: /^Search/ }).click();
    const palette = await window.getByRole('dialog').filter({ has: window.getByRole('combobox').or(window.getByRole('textbox')) }).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    await window.keyboard.press('Escape');
    await sleep(300);
    await window.getByTestId('titlebar-more').click();
    // A check item: it shows whether the mixer is open.
    await window.getByRole('menuitemcheckbox', { name: /^Mixer/ }).click();
    const mixerOpen = await window.getByTestId('mixer-panel').waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    const pressed = await window.getByTestId('timeline-mixer').getAttribute('aria-pressed');
    await window.getByTestId('timeline-mixer').click();
    const mixerClosed = await window.getByTestId('mixer-panel').waitFor({ state: 'detached', timeout: 5_000 }).then(() => true).catch(() => false);
    check('finding a command opens the palette; the mixer opens from More, and the timeline’s Mixer button shows it and closes it', palette && mixerOpen && pressed === 'true' && mixerClosed, JSON.stringify({ palette, mixerOpen, pressed, mixerClosed }));
    await window.getByTestId('titlebar-more').click();
    await window.getByRole('menuitem', { name: /^Settings/ }).click();
    const prefs = await window.getByRole('dialog', { name: 'Preferences' }).waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    check('Preferences opens from More', prefs);
    await window.getByRole('button', { name: 'Done' }).click().catch(() => window.keyboard.press('Escape'));
    await sleep(300);

    console.log('3. the library’s rail');
    const rail = await window.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-testid="library-rail"] [role="tab"]')];
      const boxes = tabs.map((tab) => tab.getBoundingClientRect());
      return {
        orientation: document.querySelector('[data-testid="library-rail"]')?.getAttribute('aria-orientation'),
        count: tabs.length,
        stacked: boxes.every((box, index) => index === 0 || box.top >= boxes[index - 1].bottom - 1),
        sameColumn: boxes.every((box) => Math.abs(box.left - boxes[0].left) < 1),
        named: tabs.every((tab) => (tab.querySelector('.library-tab-label')?.getBoundingClientRect().width ?? 0) > 16),
        names: tabs.map((tab) => tab.textContent?.trim()),
      };
    });
    check('eight parts in a rail down the side, one under the other, every name shown', rail.orientation === 'vertical' && rail.count === 8 && rail.stacked && rail.sameColumn && rail.named, JSON.stringify(rail));
    await window.getByTestId('library-tab-media').focus();
    await window.keyboard.press('ArrowDown');
    const afterDown = await window.evaluate(() => document.querySelector('[data-testid="library-rail"] [aria-selected="true"]')?.id);
    await window.keyboard.press('ArrowUp');
    const afterUp = await window.evaluate(() => document.querySelector('[data-testid="library-rail"] [aria-selected="true"]')?.id);
    check('the arrow keys move down and up the rail', afterDown === 'library-tab-titles' && afterUp === 'library-tab-media', `${afterDown}, ${afterUp}`);

    console.log('4. the name, renamed in place');
    await window.getByTestId('project-name').click();
    const field = window.getByTestId('project-name-input');
    await field.fill('Viaje a la playa');
    await field.press('Enter');
    await sleep(300);
    const unsavedName = await window.getByTestId('project-name').innerText();
    check('not saved yet, a click and Enter give the project its name', unsavedName === 'Viaje a la playa', unsavedName);
    await window.getByTestId('project-name').click();
    await window.getByTestId('project-name-input').fill('Something else');
    await window.getByTestId('project-name-input').press('Escape');
    await sleep(200);
    check('Escape keeps the old one', (await window.getByTestId('project-name').innerText()) === 'Viaje a la playa');

    const saved = join(work, 'Viaje a la playa.scf');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, saved);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'save'));
    await window.waitForFunction(() => window.__scfStore && document.querySelector('[data-testid="unsaved-indicator"]') === null, null, { timeout: 15_000 }).catch(() => undefined);
    await sleep(600);
    await window.getByTestId('project-name').click();
    await window.getByTestId('project-name-input').fill('Playa 2026');
    await window.getByTestId('project-name-input').press('Enter');
    await sleep(1200);
    const renamedFile = join(work, 'Playa 2026.scf');
    const onDisk = { old: existsSync(saved), renamed: existsSync(renamedFile) };
    const shown = await window.getByTestId('project-name').innerText();
    const recent = JSON.parse(readFileSync(join(profile, 'scf', 'recent-projects.json'), 'utf8'));
    check('saved, the file on disk is renamed with it, and the start screen lists it so', !onDisk.old && onDisk.renamed && shown === 'Playa 2026' && recent.some((entry) => entry.path === renamedFile && entry.name === 'Playa 2026'),
      JSON.stringify({ onDisk, shown, recent: recent.map((entry) => [entry.name, entry.path]) }));

    // A name taken in the folder is refused.
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(join(work, 'Otro.scf'))}, '{}')`]);
    await window.getByTestId('project-name').click();
    await window.getByTestId('project-name-input').fill('Otro');
    await window.getByTestId('project-name-input').press('Enter');
    await sleep(1000);
    // As the user reads it: the main process's sentence, nothing of Electron's in front.
    const refused = await window.getByText('There is already a project called “Otro” in that folder.', { exact: true }).first().isVisible().catch(() => false);
    check('a name another project in the folder has is refused, and said so', refused && existsSync(renamedFile) && (await window.getByTestId('project-name').innerText()) === 'Playa 2026');

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
