import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The keyboard map on Ctrl+/, as the user chose, and loop playback on R:
 * `node tests/ui/keyboard-map.mjs`
 *
 *   1. Ctrl+/ opens the keyboard map and closes it again - and so does
 *      Ctrl+Shift+7, which is Ctrl+/ on a Spanish keyboard;
 *   2. it opens from a text field too, since Ctrl+/ types nothing, while a
 *      "?" typed there stays in the field; "?" still opens it elsewhere;
 *   3. R turns loop playback on and off, the View menu ticking it; an R typed
 *      in a field stays in the field, and Ctrl+R is not the loop;
 *   4. every place that says the keys says the new ones: the loop button,
 *      the map's rows, the menus;
 *   5. in Spanish the map says how to type Ctrl+/ on a Spanish keyboard;
 *   6. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'keyboard-map');
const logs = join(work, 'logs');
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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await sleep(400);

    const mapOpen = () => window.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible().catch(() => false);
    const nowhere = () => window.evaluate(() => {
      document.getElementById('__key_field')?.remove();
      (document.activeElement)?.blur?.();
    });
    /** A text field of its own, focused, emptied. */
    const field = () => window.evaluate(() => {
      let input = document.getElementById('__key_field');
      if (!input) {
        input = document.createElement('input');
        input.id = '__key_field';
        input.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999';
        document.body.append(input);
      }
      input.value = '';
      input.focus();
    });
    const loop = () => window.evaluate(() => window.__scfStore.getState().ui.loopPlayback);
    const menuItem = (id) => app.evaluate(({ Menu }, wanted) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
      return item ? { accelerator: item.accelerator ?? null, checked: item.checked } : null;
    }, id);

    /* 1. Ctrl+/ ------------------------------------------------------------------------ */
    await nowhere();
    await window.keyboard.press('Control+/');
    await sleep(300);
    const opened = await mapOpen();
    await window.keyboard.press('Control+/');
    await sleep(400);
    const closed = !(await mapOpen());
    check('Ctrl+/ opens the keyboard map, and closes it again', opened && closed, `${opened} ${closed}`);
    // What a Spanish keyboard sends for Ctrl+/: the 7 key, with Ctrl and Shift.
    const spanish = () => window.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    await spanish();
    await sleep(300);
    const openedSpanish = await mapOpen();
    await spanish();
    await sleep(400);
    check('so does Ctrl+Shift+7, which is Ctrl+/ on a Spanish keyboard', openedSpanish && !(await mapOpen()));

    /* 2. from a text field; "?" ----------------------------------------------------------- */
    await field();
    await window.keyboard.press('Control+/');
    await sleep(300);
    const fromField = await mapOpen();
    await window.keyboard.press('Escape');
    await sleep(400);
    await field();
    await window.keyboard.type('?');
    await sleep(300);
    const typed = await window.evaluate(() => document.getElementById('__key_field').value);
    const questionInField = await mapOpen();
    check('it opens from a text field too, where a "?" typed stays in the field', fromField && typed === '?' && !questionInField, `${fromField} "${typed}" ${questionInField}`);
    await nowhere();
    await window.keyboard.press('?');
    await sleep(300);
    const question = await mapOpen();
    await window.keyboard.press('Escape');
    await sleep(400);
    check('"?" still opens it, away from a field', question);

    /* 3. R ------------------------------------------------------------------------------------ */
    await nowhere();
    const before = await loop();
    await window.keyboard.press('r');
    await sleep(400);
    const on = await loop();
    const ticked = (await menuItem('loopPlayback'))?.checked;
    await window.keyboard.press('r');
    await sleep(400);
    const off = await loop();
    check('R turns loop playback on and off, and the View menu ticks it', before === false && on === true && ticked === true && off === false, JSON.stringify({ before, on, ticked, off }));
    await field();
    await window.keyboard.type('r');
    await sleep(200);
    const rTyped = await window.evaluate(() => document.getElementById('__key_field').value);
    const rInField = await loop();
    await nowhere();
    await window.keyboard.press('Control+r');
    await sleep(300);
    const ctrlR = await loop();
    await window.keyboard.press('Escape');
    check('an R typed in a field stays there, and Ctrl+R is not the loop', rTyped === 'r' && rInField === false && ctrlR === false, JSON.stringify({ rTyped, rInField, ctrlR }));

    /* 4. where the keys are said ------------------------------------------------------- */
    const loopButton = await window.evaluate(() => {
      const button = [...document.querySelectorAll('[data-tooltip]')].find((element) => element.getAttribute('aria-label') === 'Loop playback');
      return button ? { shortcut: button.dataset.shortcut, aria: button.getAttribute('aria-keyshortcuts') } : null;
    });
    check('the loop button says R', loopButton?.shortcut === 'R' && loopButton.aria === 'R', JSON.stringify(loopButton));
    await nowhere();
    await window.keyboard.press('Control+/');
    await sleep(400);
    const rows = await window.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) => element.getAttribute('aria-label') === 'Keyboard shortcuts' || element.textContent.includes('Keyboard shortcuts'));
      // Each row's keys cell, apart from what it does.
      const all = [...(dialog?.querySelectorAll('tr, li, [role="row"]') ?? [])].map((row) => ({ keys: row.firstElementChild?.textContent.trim() ?? '', text: row.textContent }));
      return { loop: all.find((row) => row.text.includes('Loop playback on or off'))?.keys ?? null, list: all.find((row) => row.text.includes('This list'))?.keys ?? null };
    });
    await window.keyboard.press('Escape');
    await sleep(300);
    check('the map lists the loop under R and itself under Ctrl+/', rows.loop === 'R' && rows.list === 'Ctrl+/ or ?', JSON.stringify(rows));
    const menus = { shortcuts: await menuItem('shortcuts'), loop: await menuItem('loopPlayback') };
    check('and so do the menus: Help > Keyboard shortcuts on Ctrl+/, View > Loop playback on R',
      menus.shortcuts?.accelerator === 'CmdOrCtrl+/' && menus.loop?.accelerator === 'R', JSON.stringify(menus));

    /* 5. in Spanish ---------------------------------------------------------------------------- */
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(500);
    await nowhere();
    await window.keyboard.press('Control+/');
    await sleep(400);
    const spanishRow = await window.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return [...(dialog?.querySelectorAll('tr, li, [role="row"]') ?? [])].map((row) => row.textContent.replace(/\s+/g, ' ').trim()).find((text) => text.includes('Esta lista')) ?? null;
    });
    await window.keyboard.press('Escape');
    check('in Spanish the map says how to type it: Ctrl+/ (Ctrl+Mayús+7) o ?', /Ctrl\+\/ \(Ctrl\+Mayús\+7\) o \?/.test(spanishRow ?? ''), spanishRow ?? 'no row');

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
