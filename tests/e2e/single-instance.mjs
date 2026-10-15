import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { _electron as electron } from 'playwright';

/**
 * A second copy of the app opens no window.
 *
 * One instance per profile, so two windows cannot fight over the same project
 * file. The copy that loses the lock used to call app.quit() and then carry on
 * building its window: the module keeps running, and the window it made loaded
 * the page and never painted again, because Chromium was shutting down under
 * it. On screen that is a dead window in front of the live one; for anything
 * driving the app it is worse, because the page answers questions and ignores
 * clicks for ever.
 *
 * This checks the second copy from the outside: no window of its own, and the
 * first copy still working afterwards.
 */

const root = resolve(process.cwd());
const profile = join(root, '.e2e-tmp', 'profile-instance');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const launch = () =>
  electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1' },
  });

async function main() {
  rmSync(profile, { recursive: true, force: true });

  const first = await launch();
  let second = null;

  try {
    const window = await first.firstWindow();
    await window.waitForSelector('#root > *', { timeout: 30_000 });
    check('the first copy opens its window', await window.evaluate(() => Boolean(document.querySelector('#root > *'))), 'page is up');

    // The second copy. It should quit without a window - and a copy that quits
    // that early never finishes Playwright's handshake, so the launch itself
    // failing is the result, not an error.
    let stray = null;
    try {
      second = await launch();
      stray = await second
        .firstWindow({ timeout: 8000 })
        .then((page) => page.title().catch(() => 'a window with no title'), () => null);
    } catch (error) {
      stray = null;
      console.log(`   the second copy quit before it could be driven: ${error.message.split('\n')[0].slice(0, 80)}`);
    }
    check('the second copy opens no window at all', stray === null, stray ?? 'none appeared');

    const windows = await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    check('the first copy still has exactly one window', windows === 1, `${windows} window(s)`);

    // A window that paints is a window that works; a dead one answers reads
    // but never redraws, so frames are what tells them apart.
    const frames = await window.evaluate(
      () =>
        new Promise((done) => {
          let count = 0;
          const start = performance.now();
          const tick = () => {
            count += 1;
            if (performance.now() - start > 500) done(count);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          setTimeout(() => done(count), 1500);
        }),
    );
    check('and it is still painting', frames > 5, `${frames} frames in half a second`);

    const clicked = await window
      .getByRole('button', { name: 'Blank project' })
      .click({ timeout: 8000 })
      .then(() => true, () => false);
    check('and it still answers a click', clicked, clicked ? 'Blank project opened' : 'the click hung');
  } finally {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
  }

  const failed = results.filter((item) => !item.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
