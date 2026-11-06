import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Best moments, in the running app: `node tests/ui/highlights.mjs`
 *
 * The fixture is made by the app's own text to speech, with pauses written
 * into the script - so there is real speech with real silences between it,
 * and the answer can be checked against what was actually said rather than
 * against a recording nobody can look at.
 *
 * Needs the staged build/ (piper and its voices), like the caption tests.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'highlights');
const ttsDir = join(root, 'build', 'piper');
const voicesDir = join(root, 'build', 'tts-voices');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Two long stretches of talking with a clear gap between them. The pauses are
 * the app's own mark, so the silence is exactly where this test says it is.
 */
const SCRIPT =
  'Primero voy a explicar la idea con calma, porque conviene entenderla bien antes de seguir adelante con lo demás. ' +
  '[pausa 2s] ' +
  'Y ahora el segundo punto, que también lleva su tiempo y merece la misma atención que el anterior para que quede claro.';

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  for (const [path, what] of [[ttsDir, 'piper'], [voicesDir, 'the voices']]) {
    if (!existsSync(path)) throw new Error(`Missing ${what} at ${path} - stage build/ first.`);
  }
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_TTS_DIR: ttsDir,
      SCF_TTS_BUNDLED_DIR: voicesDir,
      SCF_TTS_VOICES_DIR: join(work, 'voices'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. a recording with two stretches of talking and a gap between');
    await window.getByTestId('library-tab-voice').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 15_000 });
    await window.getByTestId('tts-text').fill(SCRIPT);
    await window.getByTestId('tts-generate').click();
    const spoke = await window
      .waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length > 0, null, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check('the app speaks it', spoke);
    if (!spoke) throw new Error('no voice');
    await sleep(800);

    const clip = await window.evaluate(() => {
      const state = window.__scfStore.getState();
      const made = Object.values(state.project.clips)[0];
      state.setUi({ selectedClipIds: [made.id], selectedTrackId: made.trackId });
      return { id: made.id, seconds: Math.round(made.durationFrames / state.project.fps) };
    });
    console.log(`   the recording is ${clip.seconds}s long`);

    console.log('2. it finds the moments');
    await window.getByTestId('inspector-highlights').click();
    await window.getByTestId('highlights-dialog').waitFor({ state: 'visible', timeout: 10_000 });
    const answered = await window
      .waitForFunction(
        () =>
          document.querySelector('[data-testid="highlights-list"]') ||
          document.querySelector('[data-testid="highlights-none"]') ||
          document.querySelector('[data-testid="highlights-failed"]'),
        null,
        { timeout: 120_000 },
      )
      .then(() => true)
      .catch(() => false);
    const problem = await window.getByTestId('highlights-failed').textContent().catch(() => null);
    const none = await window.getByTestId('highlights-none').textContent().catch(() => null);
    const found = await window.evaluate(() => document.querySelectorAll('[data-testid="highlights-list"] li').length);
    check('it comes back with moments', answered && found > 0, problem ?? none ?? `${found} found`);
    if (found === 0) throw new Error(problem ?? none ?? 'none found');

    // The script has two stretches, so two is what it should find - the pause
    // between them is the boundary an editor would cut on.
    check('it finds the two stretches the script actually has', found === 2, `${found} moments`);

    console.log('3. marking changes nothing but the markers');
    const before = await window.evaluate(() => {
      const state = window.__scfStore.getState();
      return { markers: (state.project.markers ?? []).length, clips: Object.keys(state.project.clips).length, depth: window.__scfHistory.getState().undoStack.length };
    });
    await window.getByTestId('highlights-mark').click();
    await sleep(800);
    const marked = await window.evaluate(() => {
      const state = window.__scfStore.getState();
      return { markers: (state.project.markers ?? []).length, clips: Object.keys(state.project.clips).length, depth: window.__scfHistory.getState().undoStack.length };
    });
    check('a marker per moment', marked.markers === before.markers + found, `${before.markers} -> ${marked.markers}`);
    check('and not a frame was cut', marked.clips === before.clips, `${before.clips} -> ${marked.clips} clips`);
    check('all of it one undo step', marked.depth === before.depth + 1, `${before.depth} -> ${marked.depth}`);

    console.log('4. keeping only the moments shortens the recording');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(400);
    await window.getByTestId('inspector-highlights').click();
    await window.getByTestId('highlights-dialog').waitFor({ state: 'visible', timeout: 10_000 });
    await window
      .waitForFunction(() => document.querySelector('[data-testid="highlights-list"] li'), null, { timeout: 120_000 })
      .catch(() => undefined);
    const lengthBefore = await window.evaluate((id) => {
      const state = window.__scfStore.getState();
      return Object.values(state.project.clips).reduce((total, one) => total + (one.sourceUri === state.project.clips[id]?.sourceUri ? one.durationFrames : 0), 0);
    }, clip.id);
    await window.getByTestId('highlights-keep').click();
    await sleep(1200);
    const lengthAfter = await window.evaluate((id) => {
      const state = window.__scfStore.getState();
      const uri = Object.values(state.project.clips)[0]?.sourceUri;
      void id;
      return Object.values(state.project.clips).reduce((total, one) => total + (one.sourceUri === uri ? one.durationFrames : 0), 0);
    }, clip.id);
    check('the recording is shorter than it was', lengthAfter < lengthBefore, `${lengthBefore} -> ${lengthAfter} frames`);
    check('but not empty: the talking is still there', lengthAfter > 0, `${lengthAfter} frames`);

    check('nothing in the console', issues.length === 0, issues.slice(0, 2).join(' | '));
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
