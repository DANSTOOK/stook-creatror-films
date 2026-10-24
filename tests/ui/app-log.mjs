import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The app's error log, in the running app: `node tests/ui/app-log.mjs`
 *
 *   1. what goes wrong is written down, each with where it came from: an
 *      exception on the page, a promise nobody caught, a console error, an
 *      error the user is shown, and a request to the main process that
 *      failed (by its channel); the start of the app too;
 *   2. Preferences > Diagnostics counts today's errors;
 *   3. Help > Copy diagnostic report puts the versions and the newest lines
 *      on the clipboard.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'app-log');
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
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. written down');
    await window.evaluate(async () => {
      setTimeout(() => {
        throw new Error('probe: thrown on the page');
      }, 0);
      void Promise.reject(new Error('probe: nobody caught this'));
      console.error('probe: a console error');
      await window.filmora.templateRead('not a valid id!').catch(() => undefined);
    });
    // An error the user is shown, the way the app shows one: a file that is not a video.
    const broken = join(work, 'broken.mp4');
    writeFileSync(broken, Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 251)));
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [broken]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await sleep(4000);
    const file = readdirSync(logs).find((name) => /^scf-\d{4}-\d{2}-\d{2}\.log$/.test(name));
    const text = file ? readFileSync(join(logs, file), 'utf8') : '';
    check('one file a day in the log folder', Boolean(file), file ?? 'none');
    check('the start of the app', /INFO  \[main\] Started \d/.test(text));
    check('an exception on the page, with where it was', /ERROR \[renderer:window\] probe: thrown on the page/.test(text) && /\n {4}at /.test(text));
    check('a promise nobody caught', /ERROR \[renderer:promise\] probe: nobody caught this/.test(text));
    check('a console error', /ERROR \[renderer:console\] probe: a console error/.test(text));
    check('an error the user was shown, in their words', /ERROR \[renderer:notice\] Could not import broken\.mp4/.test(text), text.split('\n').filter((line) => line.includes('notice')).join(' | '));
    check('a request to the main process that failed, by its channel', /ERROR \[ipc:templates:read\] .*Not a template/.test(text), text.split('\n').filter((line) => line.includes('ipc:')).join(' | '));

    console.log('2. Preferences > Diagnostics');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    const count = await window.getByTestId('diagnostics-count').innerText({ timeout: 10_000 }).catch(() => '');
    check('it counts today’s errors and shows the last', /\d+ errors logged today/.test(count) && /Last:/.test(count), count.replace(/\n/g, ' | '));
    await window.getByRole('button', { name: 'Done' }).click().catch(() => window.keyboard.press('Escape'));

    console.log('3. Copy diagnostic report');
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'copyDiagnostics'));
    await sleep(800);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    check('the versions and the newest lines go on the clipboard', /^STOOK CREATOR FILMS \d/.test(copied) && /GPU: webgl2/.test(copied) && copied.includes('probe: nobody caught this'), copied.split('\n').slice(0, 3).join(' | '));
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
