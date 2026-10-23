import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Workspaces, in the running app: `node tests/ui/workspaces.mjs`
 *
 * With a clip selected:
 *   1. Color puts the library away, opens the scopes beside the picture and
 *      brings the inspector's Color tab forward;
 *   2. Audio opens the mixer, the inspector's Audio tab and the library's
 *      Sounds;
 *   3. Editing brings every panel back, closes the mixer and the scopes, and
 *      shows the clip's picture settings;
 *   4. the last one chosen is the picker's after a restart.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'workspaces');
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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
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
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);
  const issues = [];

  let session = await launch(profile);
  try {
    const { app, window } = session;
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const id = s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      window.__scfStore.getState().selectClips([id]);
    });
    await sleep(500);
    const state = () => window.evaluate(() => ({
      library: Boolean(document.querySelector('[data-testid="media-panel"]')?.offsetParent),
      scopes: Boolean(document.querySelector('[data-testid="scopes-panel"]')),
      mixer: Boolean(document.querySelector('[data-testid="mixer-panel"]')),
      sounds: Boolean(document.querySelector('[data-testid="library-sounds"]')?.offsetParent),
      tab: document.querySelector('[data-panel="inspector"] [role="tablist"] [aria-selected="true"], [data-testid="inspector-panel"] [role="tablist"] [aria-selected="true"]')?.textContent ?? [...document.querySelectorAll('[role="tablist"]')].filter((list) => !list.closest('[data-testid="media-panel"]')).map((list) => list.querySelector('[aria-selected="true"]')?.textContent).find(Boolean) ?? null,
    }));
    const pick = async (id) => {
      await window.getByTestId('workspace-picker').selectOption(id);
      await sleep(600);
      return state();
    };

    console.log('1. Color');
    const color = await pick('color');
    check('Color: the library away, the scopes open, the inspector on Color', !color.library && color.scopes && !color.mixer && color.tab === 'Color', JSON.stringify(color));
    console.log('2. Audio');
    const audio = await pick('audio');
    check('Audio: the mixer, the inspector on Audio, the library on Sounds', audio.library && audio.mixer && audio.sounds && !audio.scopes && audio.tab === 'Audio', JSON.stringify(audio));
    console.log('3. Editing');
    await pick('color');
    const editing = await pick('editing');
    check('Editing: every panel back, no mixer or scopes, the clip’s picture settings', editing.library && !editing.mixer && !editing.scopes && editing.tab === 'Video', JSON.stringify(editing));
    await pick('audio');
  } finally {
    await close(session);
  }

  console.log('4. after a restart');
  session = await launch(profile);
  try {
    await session.window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await session.window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const shown = await session.window.getByTestId('workspace-picker').inputValue({ timeout: 10_000 }).catch(() => null);
    check('the last one chosen is the picker’s after a restart', shown === 'audio', String(shown));
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
