import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Cloud backup, in the running app: `node tests/ui/cloud-backup.mjs`
 *
 *   1. Preferences > Cloud backup: a folder chosen in the dialog becomes
 *      where the copies go;
 *   2. each save leaves a dated copy of the project there, in the project's
 *      own folder under "STOOK Backups", the same as the file saved;
 *   3. Back up now makes one more and says when; Off stops them.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'cloud-backup');
const cloud = join(work, 'OneDrive');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const copies = () => {
  const base = join(cloud, 'STOOK Backups');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((folder) => readdirSync(join(base, folder)).filter((name) => name.endsWith('.scf')).map((name) => join(base, folder, name))).sort();
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(cloud, { recursive: true });
  const projectPath = join(work, 'Viaje.scf');
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
    const command = (name) => app.evaluate(({ BrowserWindow }, which) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', which), name);
    const closePreferences = async () => {
      await window.getByRole('button', { name: 'Done' }).click().catch(() => window.keyboard.press('Escape'));
      await sleep(300);
    };

    console.log('1. choose the folder');
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, cloud);
    await command('preferences');
    const section = window.getByTestId('cloud-backup');
    const shown = await section.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    check('Preferences has Cloud backup', shown);
    await window.getByTestId('cloud-backup-folder').selectOption({ label: 'Choose a folder…' });
    await sleep(500);
    const chosen = await window.getByTestId('cloud-backup-folder').inputValue();
    const status = await window.getByTestId('cloud-backup-status').innerText().catch(() => '');
    check('the folder chosen is where copies go, none yet', chosen === cloud && /No copy yet/.test(status), `${chosen} | ${status}`);
    await closePreferences();

    console.log('2. each save, a copy');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, projectPath);
    await command('save');
    await window.getByText('Saved to', { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(800);
    const first = copies();
    check('the save leaves a copy in the project\'s own folder under STOOK Backups, the same as the file',
      first.length === 1 && /Viaje-/.test(first[0]) && readFileSync(first[0], 'utf8') === readFileSync(projectPath, 'utf8'), first.join(' | '));
    await window.evaluate(() => window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 0 }));
    await sleep(300);
    await command('save');
    await sleep(1200);
    const second = copies();
    check('the next save, another', second.length === 2 && readFileSync(second[1], 'utf8') === readFileSync(projectPath, 'utf8'), `${second.length} copies`);

    console.log('3. Back up now, and Off');
    await command('preferences');
    await window.getByTestId('cloud-backup-now').click();
    await sleep(800);
    const after = await window.getByTestId('cloud-backup-status').innerText();
    check('Back up now makes one more and says when', copies().length === 3 && /Last copy:/.test(after), `${copies().length} copies | ${after}`);
    await window.getByTestId('cloud-backup-folder').selectOption({ label: 'Off' });
    await sleep(400);
    await closePreferences();
    await window.evaluate(() => window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 90 }));
    await command('save');
    await sleep(1200);
    check('Off: a save makes no copy', copies().length === 3, `${copies().length} copies`);
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
